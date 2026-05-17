// 配平开仓 (一次性): 钱包两两配对, 每对随机选 symbol, 一 long 一 short 等量开仓.
// **不自动平仓**, 由用户手动控制何时平 (用 cleanup.mjs <idx...> 或下次 trade.mjs 启动 cleanupOnStart).
//
// 复用 config.instant 的:
//   notionalUsdRange / symbolPrefixes / underlyings / maxSpread
//   minLiquidityMultiplier / minDistinctMarketsPerWeek / lookbackDays
//   openMaxAttempts / openMinFillRatio / retryGapMs
//
// 算法:
//   1) shuffle 选中钱包 → 两两 pair
//   2) 每 pair 算 traded markets union (两边过去 7 天合计, instant+balance-open 都算)
//   3) 选 symbol: prefix + underlying + 流动性双侧 ≥ notional × mult + market 不在 union
//   4) 随机分配 long/short, 两端并发 fillIoc 凑齐 notional
//   5) 凑齐 < 99% → 双向 rollback, pair 失败
//   6) 等量校验: 多的那边反向同 symbol 平差额拉平 (|volL - volS| 几 USDT 之内)
//   7) state.json 记两个 record (一 buy 一 sell), strategy="balance-open", positionsClean=false
//
// 用法:
//   node balance-open.mjs 1-100              钱包 1-100 配 50 对
//   node balance-open.mjs 1 4 8 9            指定 4 个钱包 → 2 对
//   node balance-open.mjs --c=5              并发 pair 数 (默认 5)
//   node balance-open.mjs --yes              跳过确认
//   node balance-open.mjs --dry-run          模拟 (打印 pair + 选 symbol, 不发单)
//   node balance-open.mjs --force            强制 (跳过链上检查, 不管已有持仓直接 shuffle 配对)
//
// 默认行为 (再跑同命令自动补完):
//   1. 查链上 positions, 按 symbol 集合内贪婪配对 long↔short
//   2. 已配平的钱包 skip (本轮无动作)
//   3. 残留 < 100 USDT  → 自动 close-position 平掉
//   4. 残留 ≥ 100 USDT  → 找 free 钱包反向开同量 hedge (free 不够则退化 cleanup)
//   5. 完全无持仓的 free 钱包 → 内部两两 normal pair (新开)
//
// 之后平仓:
//   node cleanup.mjs <成功 pair 的所有 idx>     # 用 close-position flag 把两边平掉

import fs from "fs";
import readline from "readline";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { HttpsProxyAgent } from "https-proxy-agent";
import { askPassword, loadWallets } from "./lib/cipher.mjs";
import { RhoClient, fetchExchangeInfo, fetchAllTickersMap } from "./lib/rho.mjs";
import { loadState, saveState, dayKey, appendRun } from "./lib/state.mjs";
import { config } from "./config.mjs";

const STRATEGY = "balance-open";
const __dirname = dirname(fileURLToPath(import.meta.url));

process.on("unhandledRejection", r => console.warn(`[unhandledRejection] ${r?.message?.slice(0, 200) || r}`));
process.on("uncaughtException", e => console.warn(`[uncaughtException] ${e?.message?.slice(0, 200) || e}`));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 19);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
const errMsg = e => e?.response
    ? `${e.response.status} ${JSON.stringify(e.response.data).slice(0, 200)}`
    : (e?.shortMessage || e?.message || String(e));
const formatErr = errMsg;

const symbolToMarket = s => s ? s.split(":")[0] : s;

function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function pastDayKeys(today, lookback, boundary) {
    const base = new Date(today + "T12:00:00");
    const out = [];
    for (let d = 0; d < lookback; d++) {
        const date = new Date(base);
        date.setDate(date.getDate() - d);
        out.push(dayKey(date, boundary));
    }
    return out;
}

// 跨 strategy 看 traded markets (instant + balance-open 都算, 项目方 quest 也是按 wallet 总和算)
function tradedMarketsFor(state, address, today, lookback, boundary) {
    const markets = new Set();
    if (!state || !address) return markets;
    const k = address.toLowerCase();
    for (const day of pastDayKeys(today, lookback, boundary)) {
        const dayRuns = state[k]?.runs?.[day] || {};
        for (const arr of Object.values(dayRuns)) {
            const xs = Array.isArray(arr) ? arr : [arr];
            for (const r of xs) {
                if (r?.status === "ok" && r.symbol) markets.add(symbolToMarket(r.symbol));
            }
        }
    }
    return markets;
}

function passesLiquidityCheck(ticker, notional, maxSpread, mult) {
    if (!ticker) return false;
    const bid = parseFloat(ticker.bidPrice);
    const ask = parseFloat(ticker.askPrice);
    const bidSize = parseFloat(ticker.bidSize);
    const askSize = parseFloat(ticker.askSize);
    if (![bid, ask, bidSize, askSize].every(Number.isFinite)) return false;
    if (ask - bid > maxSpread) return false;
    const need = notional * mult;
    if (bidSize < need || askSize < need) return false;
    return true;
}

function pickNotional() {
    const cfg = config.instant;
    if (Array.isArray(cfg.notionalUsdRange) && cfg.notionalUsdRange.length === 2) {
        const [a, b] = cfg.notionalUsdRange;
        return randInt(Math.min(a, b), Math.max(a, b));
    }
    return cfg.notionalUsd ?? 1005;
}

function selectSymbolForPair({ exchangeInfo, tickers, notional, tradedA, tradedB, minDistinct }) {
    const cfg = config.instant;
    let candidates = exchangeInfo.symbols.filter(s => {
        if (s.isExpired || s.isLockedUp || s.pausedOrders) return false;
        if (parseFloat(s.minTradeNotional) > notional) return false;
        if (s.productType !== "funding-rate-futures") return false;
        if (cfg.underlyings && !cfg.underlyings.includes(s.underlyingAsset)) return false;
        return true;
    });
    if (cfg.symbolPrefixes?.length) {
        candidates = candidates.filter(s => cfg.symbolPrefixes.some(p => s.symbol.startsWith(p)));
    }
    if (!candidates.length) return null;

    // 双侧深度 + spread
    candidates = candidates.filter(s => passesLiquidityCheck(
        tickers[s.symbol], notional,
        cfg.maxSpread ?? Infinity,
        cfg.minLiquidityMultiplier ?? 1,
    ));
    if (!candidates.length) return null;

    // 多样性: 按每钱包独立判断 distinct 缺口
    // - 都没满 → 优先选双赢 (A,B 都没碰过); 没双赢退到至少一边没碰过
    // - 只 A 没满 → 选 A 没碰过的 (B 重不重复无所谓, B 已经达 quest)
    // - 只 B 没满 → 选 B 没碰过的
    // - 都满了 → 不强制, 纯随机
    const needA = tradedA.size < minDistinct;
    const needB = tradedB.size < minDistinct;
    const aHas = s => tradedA.has(symbolToMarket(s.symbol));
    const bHas = s => tradedB.has(symbolToMarket(s.symbol));

    if (needA && needB) {
        const both = candidates.filter(s => !aHas(s) && !bHas(s));
        if (both.length > 0) candidates = both;
        else {
            const either = candidates.filter(s => !aHas(s) || !bHas(s));
            if (either.length > 0) candidates = either;
        }
    } else if (needA) {
        const aMiss = candidates.filter(s => !aHas(s));
        if (aMiss.length > 0) candidates = aMiss;
    } else if (needB) {
        const bMiss = candidates.filter(s => !bHas(s));
        if (bMiss.length > 0) candidates = bMiss;
    }

    // 近月优先, 同 underlying 内随机
    candidates.sort((a, b) => new Date(a.maturityDate) - new Date(b.maturityDate));
    const byU = {};
    for (const s of candidates) (byU[s.underlyingAsset] ??= []).push(s);
    const u = pick(Object.keys(byU));
    return pick(byU[u].slice(0, 2));
}

function makeAgent(p) {
    if (!config.useProxy || !p) return null;
    const auth = p.username
        ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@`
        : "";
    return new HttpsProxyAgent(`http://${auth}${p.host}:${p.port}`);
}

async function buildClient(w) {
    const c = new RhoClient({
        apiBase: config.apiBase,
        privateKey: w.privateKey,
        httpAgent: makeAgent(w.proxy),
    });
    await c.login();
    return c;
}

// 多次 IOC 凑齐 target vol (复制自 strategies/instant.mjs)
async function fillIoc(client, symbol, side, target, opts, log, cidPrefix) {
    const { maxAttempts = 5, retryGapMs = 500, minNotional = 100 } = opts;
    const fills = [];
    let totalVol = 0;
    let totalFee = 0;
    let lastTrade = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const remainingRaw = target - totalVol;
        const remaining = Math.floor(remainingRaw * 1e6) / 1e6;
        if (remaining < minNotional) break;
        const cid = `${cidPrefix}${attempt > 1 ? attempt : ""}`.slice(0, 36);
        let resp;
        try {
            resp = await client.createOrder({
                orderType: "market", symbol, side,
                quantity: remaining.toFixed(6),
                timeInForce: "IOC", clientOrderId: cid,
            });
        } catch (e) {
            log(`  ${cidPrefix} #${attempt} 异常: ${formatErr(e).slice(0, 80)}`);
            return { fills, totalVol, totalFee, lastTrade, error: e };
        }
        const tr = resp.trades?.[0];
        if (!tr) {
            if (attempt < maxAttempts) await sleep(retryGapMs);
            continue;
        }
        const v = parseFloat(tr.volume);
        totalVol += v;
        totalFee += parseFloat(tr.tradingFees) || 0;
        lastTrade = tr;
        fills.push(tr);
        log(`  ${cidPrefix} #${attempt}: px=${tr.price} vol=${v} fee=${tr.tradingFees}${totalVol < target - 0.01 ? ` (${totalVol.toFixed(2)}/${target})` : ""}`);
        if (totalVol >= target - 0.01) break;
        if (attempt < maxAttempts) await sleep(retryGapMs);
    }
    return { fills, totalVol, totalFee, lastTrade };
}

// Cleanup 模式: exposed 残量过小 (< minNotional 100, 无法用 IOC 反向), 直接 close-position 平掉
async function processCleanup({ exposedWallet, exposedPosition, state, today, dryRun }) {
    const e = exposedWallet;
    const pos = exposedPosition;
    const vol = Math.abs(parseFloat(pos.notional));
    const tag = `[${e.idx}-cleanup]`;
    const log = m => console.log(`[${ts()}] ${tag} ${m}`);

    log(`残量 ${vol} ${pos.riskDirection} ${pos.symbol} < minNotional 100, close-position 自平`);
    if (dryRun) {
        log(`[DRY] close-position ${pos.symbol}`);
        return { ok: true, dry: true, mode: "cleanup", pair: [e.idx], symbol: pos.symbol, notional: vol };
    }

    let client;
    try { client = await buildClient(e); }
    catch (err) { return { ok: false, error: `login: ${errMsg(err)}`, mode: "cleanup", pair: [e.idx] }; }

    const cid = `bc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 36);
    try {
        const r = await client.createOrder({
            orderType: "market", symbol: pos.symbol, timeInForce: "IOC",
            flags: ["close-position"], clientOrderId: cid,
        });
        const tr = r.trades?.[0];
        if (tr) log(`✓ closed ${pos.symbol} fill=${tr.price}@${tr.volume} fee=${tr.tradingFees}`);
        else log(`✓ close-position 发出 (无 trade 回执, 可能已 0)`);
        return { ok: true, mode: "cleanup", pair: [e.idx], symbol: pos.symbol, notional: vol };
    } catch (err) {
        log(`✗ close-position 失败: ${errMsg(err)}`);
        return { ok: false, error: `close-position: ${errMsg(err)}`, mode: "cleanup", pair: [e.idx] };
    }
}

// Hedge 模式: 一个钱包已有持仓 (exposed), 让另一个无持仓钱包 (free) 反向开同 symbol 同量配平
// 不动 exposed 钱包, 只在 free 钱包发反向单 (省 1 笔 fee, 也不需要 cleanup 残留)
async function processHedge({ exposedWallet, freeWallet, exposedPosition, state, today, dryRun }) {
    const e = exposedWallet, f = freeWallet;
    const pos = exposedPosition;
    const symbol = pos.symbol;
    const targetVol = Math.abs(parseFloat(pos.notional));
    const freeSide = pos.riskDirection === "long" ? "sell" : "buy";   // 反向
    const exposedSideTag = pos.riskDirection === "long" ? "buy" : "sell";
    const tag = `[${e.idx}(已${pos.riskDirection})+${f.idx}(补${freeSide})]`;
    const log = m => console.log(`[${ts()}] ${tag} ${m}`);

    log(`hedge ${symbol} target=${targetVol} (e=${e.idx} 已有 ${pos.riskDirection} ${targetVol} @ ${pos.avgPrice})`);

    if (dryRun) {
        log(`[DRY] free 钱包 ${f.idx} 将 ${freeSide} ${targetVol} ${symbol} 配平`);
        return { ok: true, dry: true, mode: "hedge", pair: [e.idx, f.idx], symbol, notional: targetVol };
    }

    let freeClient;
    try {
        freeClient = await buildClient(f);
    } catch (err) {
        return { ok: false, error: `login: ${errMsg(err)}`, mode: "hedge", pair: [e.idx, f.idx] };
    }

    const sym = { symbol, minTradeNotional: "100" };   // 用真实 exchange-info 的限制
    const cfg = config.instant;
    const opts = {
        maxAttempts: cfg.openMaxAttempts ?? 5,
        retryGapMs: cfg.retryGapMs ?? 500,
        minNotional: 100,
    };
    const cidBase = `bh${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const logF = m => console.log(`[${ts()}] [${f.idx}-${freeSide.toUpperCase()}] ${m}`);

    const fill = await fillIoc(freeClient, symbol, freeSide, targetVol, opts, logF, cidBase);
    const volF = fill.totalVol;
    const diff = Math.abs(volF - targetVol);
    const balanced = diff < 0.5;   // 0.5 USDT 容差

    if (!balanced && volF > 0) {
        log(`!! 配平量差 ${diff.toFixed(4)} (free 凑了 ${volF.toFixed(2)} / ${targetVol})`);
    }
    if (volF === 0) {
        return { ok: false, error: `hedge fail: free 钱包 0 成交`, mode: "hedge", pair: [e.idx, f.idx] };
    }

    // 记 state: free 钱包记一笔 balance-open record (与 exposed 钱包成对)
    const avgPx = fill.fills.length
        ? (fill.fills.reduce((s, t) => s + parseFloat(t.price) * parseFloat(t.volume), 0) / fill.totalVol).toFixed(8)
        : null;
    appendRun(state, f.address, today, STRATEGY, {
        strategy: STRATEGY,
        status: balanced ? "ok" : "partial",
        ts: new Date().toISOString(),
        symbol,
        underlying: pos.symbol.includes("ETH") ? "ETH" : "BTC",
        maturity: null,
        side: freeSide === "buy" ? "buy" : "sell",
        open: { avgPrice: avgPx, volume: volF.toFixed(4), fee: fill.totalFee.toFixed(6), fills: fill.fills.length },
        pairWith: e.address,
        positionsClean: false,
        _mode: "hedge",   // 标记: 这是 hedge 补齐, 不是新 pair
    });

    log(`✓ hedge 完成 free ${freeSide} ${volF.toFixed(2)} (diff=${diff.toFixed(4)})`);
    return { ok: balanced, mode: "hedge", pair: [e.idx, f.idx], symbol, exposed: targetVol.toFixed(2), filled: volF.toFixed(2), diff: diff.toFixed(4) };
}

async function processPair({ pair, exchangeInfo, tickers, state, today, dryRun }) {
    const [a, b] = pair;
    const tag = `[${a.idx}+${b.idx}]`;
    const log = m => console.log(`[${ts()}] ${tag} ${m}`);

    const lookback = config.instant.lookbackDays ?? 7;
    const minDistinct = config.instant.minDistinctMarketsPerWeek ?? 3;
    const trA = tradedMarketsFor(state, a.address, today, lookback, config.dayBoundary);
    const trB = tradedMarketsFor(state, b.address, today, lookback, config.dayBoundary);
    const needA = trA.size < minDistinct;
    const needB = trB.size < minDistinct;
    log(`A=${a.idx} markets=${trA.size}/${minDistinct} ${needA ? "缺" : "✓"} | B=${b.idx} markets=${trB.size}/${minDistinct} ${needB ? "缺" : "✓"}`);

    const notional = pickNotional();
    const sym = selectSymbolForPair({ exchangeInfo, tickers, notional, tradedA: trA, tradedB: trB, minDistinct });
    if (!sym) {
        log(`✗ 无可用 symbol`);
        return { ok: false, error: "no candidate symbol", pair: [a.idx, b.idx] };
    }
    const t = tickers[sym.symbol];
    log(`pick ${sym.symbol} notional=${notional} bid=${t.bidPrice}@${t.bidSize} ask=${t.askPrice}@${t.askSize}`);

    // 随机决定谁 long
    const longFirst = Math.random() < 0.5;
    const longW = longFirst ? a : b;
    const shortW = longFirst ? b : a;
    log(`L=${longW.idx} (${longW.address.slice(0,10)})  S=${shortW.idx} (${shortW.address.slice(0,10)})`);

    if (dryRun) {
        log(`[DRY] 将开 long=${notional} short=${notional} on ${sym.symbol}, 不发单`);
        return { ok: true, dry: true, pair: [longW.idx, shortW.idx], symbol: sym.symbol, notional };
    }

    let longClient, shortClient;
    try {
        [longClient, shortClient] = await Promise.all([buildClient(longW), buildClient(shortW)]);
    } catch (e) {
        log(`✗ login 失败: ${errMsg(e)}`);
        return { ok: false, error: `login: ${errMsg(e)}`, pair: [a.idx, b.idx] };
    }

    const cfg = config.instant;
    const minNotional = parseFloat(sym.minTradeNotional) || 100;
    const optsFill = {
        maxAttempts: cfg.openMaxAttempts ?? 5,
        retryGapMs: cfg.retryGapMs ?? 500,
        minNotional,
    };
    const cidBase = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const logL = m => console.log(`[${ts()}] [${longW.idx}-L] ${m}`);
    const logS = m => console.log(`[${ts()}] [${shortW.idx}-S] ${m}`);

    // 两端并发开仓
    const [openL, openS] = await Promise.all([
        fillIoc(longClient, sym.symbol, "buy",  notional, optsFill, logL, cidBase + "L"),
        fillIoc(shortClient, sym.symbol, "sell", notional, optsFill, logS, cidBase + "S"),
    ]);
    const volL = openL.totalVol, volS = openS.totalVol;

    const minFill = (cfg.openMinFillRatio ?? 0.99) * notional;
    if (volL < minFill || volS < minFill) {
        log(`✗ 凑齐失败 L=${volL.toFixed(2)} S=${volS.toFixed(2)} < ${minFill.toFixed(2)}, 反向回滚`);
        const rb = [];
        if (volL > 0) rb.push(fillIoc(longClient, sym.symbol, "sell", volL, optsFill, logL, cidBase + "Lrb"));
        if (volS > 0) rb.push(fillIoc(shortClient, sym.symbol, "buy", volS, optsFill, logS, cidBase + "Srb"));
        await Promise.all(rb);
        log(`回滚完成, 残留靠 cleanup.mjs 扫`);
        return { ok: false, error: `凑齐失败 L=${volL.toFixed(2)} S=${volS.toFixed(2)}`, pair: [longW.idx, shortW.idx] };
    }

    // 配平校验: |volL - volS| > 0.01 → 多的那边反向同 symbol 平差额
    const diff = volL - volS;
    if (Math.abs(diff) > 0.01) {
        if (diff > 0) {
            log(`配平差 +${diff.toFixed(4)} (long 多), L 反向 sell ${diff.toFixed(4)}`);
            await fillIoc(longClient, sym.symbol, "sell", diff, optsFill, logL, cidBase + "Lfix");
        } else {
            log(`配平差 ${diff.toFixed(4)} (short 多), S 反向 buy ${Math.abs(diff).toFixed(4)}`);
            await fillIoc(shortClient, sym.symbol, "buy", Math.abs(diff), optsFill, logS, cidBase + "Sfix");
        }
    }

    const avgPx = openR => openR.fills.length
        ? (openR.fills.reduce((s, t) => s + parseFloat(t.price) * parseFloat(t.volume), 0) / openR.totalVol).toFixed(8)
        : null;

    const baseRecord = side => ({
        strategy: STRATEGY,
        status: "ok",
        ts: new Date().toISOString(),
        symbol: sym.symbol,
        underlying: sym.underlyingAsset,
        maturity: sym.maturityDate,
        side,
    });
    appendRun(state, longW.address, today, STRATEGY, {
        ...baseRecord("buy"),
        open: { avgPrice: avgPx(openL), volume: openL.totalVol.toFixed(4), fee: openL.totalFee.toFixed(6), fills: openL.fills.length },
        pairWith: shortW.address,
        positionsClean: false,   // 未平仓, cleanup 时再处理
    });
    appendRun(state, shortW.address, today, STRATEGY, {
        ...baseRecord("sell"),
        open: { avgPrice: avgPx(openS), volume: openS.totalVol.toFixed(4), fee: openS.totalFee.toFixed(6), fills: openS.fills.length },
        pairWith: longW.address,
        positionsClean: false,
    });

    log(`✓ 配平开仓 ${sym.symbol} L=${volL.toFixed(2)} S=${volS.toFixed(2)}`);
    return { ok: true, pair: [longW.idx, shortW.idx], symbol: sym.symbol, longVol: volL.toFixed(2), shortVol: volS.toFixed(2) };
}

function parseSelectors(args, max) {
    const tokens = args.filter(a => !a.startsWith("--"))
        .flatMap(a => String(a).split(/\s+/)).filter(Boolean);
    if (!tokens.length) return null;
    const set = new Set();
    for (const t of tokens) {
        const m = t.match(/^(\d+)(?:-(\d+))?$/);
        if (!m) { console.log(`无法识别 "${t}"`); process.exit(1); }
        const a = parseInt(m[1]);
        const b = m[2] ? parseInt(m[2]) : a;
        if (a < 1 || b < a || a > max) { console.log(`范围 ${t} 无效, 共 ${max} 钱包`); process.exit(1); }
        for (let i = a; i <= Math.min(b, max); i++) set.add(i);
    }
    return [...set].sort((a, b) => a - b);
}

function parseFlag(args, ...names) {
    for (const a of args) for (const n of names) {
        const m = a.match(new RegExp(`^--${n}=(.+)$`));
        if (m) return m[1];
    }
    return null;
}

async function confirm(msg) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = await new Promise(res => rl.question(msg, res));
    rl.close();
    return ans.trim().toLowerCase() === "yes";
}

async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes("--dry-run");
    const skipConfirm = args.includes("--yes");
    const force = args.includes("--force");
    const concurrentPairs = parseInt(parseFlag(args, "concurrency", "c") || "5");
    if (concurrentPairs < 1 || concurrentPairs > 50) { console.log("--c 必须 1-50"); process.exit(1); }

    const password = await askPassword("请输入解密密码: ");
    let wallets;
    try { wallets = loadWallets(__dirname, password); }
    catch (e) { console.log("解密失败:", e.message); process.exit(1); }

    const selected = parseSelectors(args, wallets.length);
    if (selected) wallets = selected.map(i => ({ ...wallets[i - 1], idx: i }));
    else wallets = wallets.map((w, i) => ({ ...w, idx: i + 1 }));

    if (wallets.length < 2) { console.log("至少 2 个钱包"); process.exit(1); }

    // 默认: 查链上 positions, 自动检测+补完未配平的钱包 (再跑同命令自动收尾)
    //   1. 按 symbol 把 selected 钱包内 long/short 贪婪配对 (vol 大到小)
    //   2. 配对后剩余 (单边 + vol > 容差) 视为 exposed 残留
    //      - residualVol < 100  → cleanup (close-position 自平)
    //      - residualVol ≥ 100 + 有 free partner → hedge (free 反向同量开)
    //      - residualVol ≥ 100 + 无 free → 退化为 cleanup
    //   3. 没参与 pair 的钱包 = free pool, 内部两两 normal pair
    // --force: 跳过链上检查, 全部当 free (旧行为, 强制叠加)
    const TOLERANCE = 0.5;       // 集合内 long/short 配平容差 (USDT)
    const HEDGE_MIN_VOL = 100;   // 残留 < 此值必须 close-position
    const stateFile = join(__dirname, config.stateFile);
    const state = loadState(stateFile);
    const today = dayKey(new Date(), config.dayBoundary || "local");
    const skipped = { complex: [], exposedUnpaired: [] };
    let free = [];
    let cleanupPairs = [];
    let hedgePairs = [];

    if (!force) {
        console.log(`[${ts()}] 查链上 positions (${wallets.length} 钱包, 并发 ${concurrentPairs * 2})...`);
        const posCheckQueue = [...wallets];
        const posMap = new Map();
        const posWorkers = [];
        for (let i = 0; i < Math.min(concurrentPairs * 2, posCheckQueue.length); i++) {
            posWorkers.push((async () => {
                while (posCheckQueue.length) {
                    const w = posCheckQueue.shift();
                    if (!w) break;
                    try {
                        const c = await buildClient(w);
                        const pos = (await c.getPositions()).positions ?? [];
                        const open = pos.filter(p => parseFloat(p.notional) !== 0);
                        posMap.set(w.idx, { open });
                    } catch (e) {
                        posMap.set(w.idx, { error: errMsg(e).slice(0, 60) });
                    }
                }
            })());
        }
        await Promise.all(posWorkers);

        // 按 symbol 收集所有 selected 钱包的持仓
        const symItems = {};   // sym → { longs: [{w, vol, pos}], shorts: [...] }
        const errorIdxs = new Set();
        const exposedIdxs = new Set();
        for (const w of wallets) {
            const p = posMap.get(w.idx);
            if (p?.error) { errorIdxs.add(w.idx); skipped.complex.push({ idx: w.idx, reason: p.error }); continue; }
            if (p.open.length > 1) { skipped.complex.push({ idx: w.idx, reason: `${p.open.length} positions, 暂不支持` }); continue; }
            if (p.open.length === 0) continue;
            const op = p.open[0];
            if (!symItems[op.symbol]) symItems[op.symbol] = { longs: [], shorts: [] };
            const item = { w, vol: Math.abs(parseFloat(op.notional)), pos: op };
            (op.riskDirection === "long" ? symItems[op.symbol].longs : symItems[op.symbol].shorts).push(item);
        }

        // 贪婪配对: 同 symbol long 跟 short 互相抵消, 配平的钱包视为"已配平"标记
        const hedgeNeeded = [];   // 残留 ≥ 100, 需要 free partner
        for (const [sym, g] of Object.entries(symItems)) {
            const lq = g.longs.slice().sort((a, b) => b.vol - a.vol);
            const sq = g.shorts.slice().sort((a, b) => b.vol - a.vol);
            while (lq.length && sq.length) {
                const L = lq[0], S = sq[0];
                const m = Math.min(L.vol, S.vol);
                L.vol -= m;
                S.vol -= m;
                if (L.vol <= TOLERANCE) lq.shift();
                if (S.vol <= TOLERANCE) sq.shift();
            }
            // 剩余 = 集合内未配平的残留 (单边)
            for (const x of [...lq, ...sq]) {
                if (x.vol <= TOLERANCE) continue;
                exposedIdxs.add(x.w.idx);
                if (x.vol < HEDGE_MIN_VOL) {
                    cleanupPairs.push({ exposedWallet: x.w, position: x.pos });
                } else {
                    hedgeNeeded.push({ exposedWallet: x.w, position: x.pos });
                }
            }
        }

        // free pool = 不在 errorIdxs 且不在 exposedIdxs 的钱包
        free = wallets.filter(w => !errorIdxs.has(w.idx) && !exposedIdxs.has(w.idx)
            && (posMap.get(w.idx)?.open?.length || 0) === 0
            ? true
            : !exposedIdxs.has(w.idx) && !errorIdxs.has(w.idx));
        // 上面三目稍乱, 简化: free = 完全无持仓 且不在 error/skipped 的钱包
        free = wallets.filter(w => {
            if (errorIdxs.has(w.idx)) return false;
            const p = posMap.get(w.idx);
            if (!p || p.error) return false;
            if (p.open.length === 0) return true;
            // 有持仓但已在集合内 paired (没进 exposedIdxs) → 视为 paired, skip
            return false;
        });

        // hedge 配 free partner, 不够时退化为 cleanup
        for (const h of hedgeNeeded) {
            if (free.length > 0) {
                const partner = free.shift();
                hedgePairs.push({ exposedWallet: h.exposedWallet, freeWallet: partner, position: h.position });
            } else {
                cleanupPairs.push({ exposedWallet: h.exposedWallet, position: h.position });
            }
        }
    } else {
        free = wallets;   // --force: 全部当 free shuffle
    }
    // free pool 永远开 normal pair (free = 完全无持仓的钱包, 已 paired/exposed 都不在内)

    // Normal pair: free 钱包内部 shuffle 两两配对
    const freeShuffled = shuffle(free);
    const normalPairs = [];
    for (let i = 0; i + 1 < freeShuffled.length; i += 2) {
        normalPairs.push([freeShuffled[i], freeShuffled[i + 1]]);
    }
    const dropped = freeShuffled.length % 2 === 1 ? freeShuffled[freeShuffled.length - 1] : null;

    if (hedgePairs.length === 0 && normalPairs.length === 0 && cleanupPairs.length === 0) {
        console.log(`!! 没有可执行的 pair`);
        if (skipped.exposedUnpaired.length > 0) {
            console.log(`   暴露但无 free 配对 (${skipped.exposedUnpaired.length} 个):`);
            for (const x of skipped.exposedUnpaired.slice(0, 20)) {
                console.log(`     [${x.w.idx}] ${x.position.symbol} ${x.position.riskDirection} ${Math.abs(parseFloat(x.position.notional))}`);
            }
        }
        if (skipped.complex.length > 0) {
            console.log(`   跳过 (查询失败/多持仓): ${skipped.complex.map(c => c.idx).join(",")}`);
        }
        process.exit(0);
    }

    const exposedCount = hedgePairs.length + cleanupPairs.length + skipped.exposedUnpaired.length;
    const totalPairs = hedgePairs.length + normalPairs.length + cleanupPairs.length;
    console.log(`=== 配平开仓 (balance-open) ${dryRun ? "(DRY-RUN)" : "实盘"}${force ? " [FORCE]" : ""} ===`);
    console.log(`钱包: ${wallets.length} | free: ${free.length} | exposed: ${exposedCount} (${hedgePairs.length} hedge + ${cleanupPairs.length} cleanup)${dropped ? ` | 落单: idx=${dropped.idx}` : ""} | 并发: ${concurrentPairs}`);
    console.log(`任务计划: ${cleanupPairs.length} 个 cleanup (残量<100 自平) + ${hedgePairs.length} 个 hedge (free 反向补) + ${normalPairs.length} 个 normal (新开) = ${totalPairs} 总`);
    if (skipped.exposedUnpaired.length > 0) console.log(`!! 暴露但无 free partner 跳过 ${skipped.exposedUnpaired.length}`);
    if (skipped.complex.length > 0) console.log(`!! 跳过 (查询失败/多持仓 ${skipped.complex.length}): ${skipped.complex.map(c => c.idx).join(",")}`);
    console.log(`notional: [${config.instant.notionalUsdRange.join(", ")}] (normal pair); hedge 量 = exposed 持仓量\n`);

    if (!dryRun && !skipConfirm) {
        const ok = await confirm(`将执行 ${totalPairs} 个任务 (${cleanupPairs.length} cleanup + ${hedgePairs.length} hedge + ${normalPairs.length} normal), 确认? (yes/no) `);
        if (!ok) { console.log("取消"); return; }
    }

    let exchangeInfo, tickers;
    try {
        [exchangeInfo, tickers] = await Promise.all([
            fetchExchangeInfo(config.apiBase),
            fetchAllTickersMap(config.apiBase),
        ]);
        console.log(`[${ts()}] exchange/info ${exchangeInfo.symbols?.length} symbols | tickers ${Object.keys(tickers).length}`);
    } catch (e) { console.error(`fetch 失败: ${errMsg(e)}`); process.exit(1); }

    const t0 = Date.now();
    // queue: cleanup → hedge → normal (混在一起, worker 按 type 分发)
    const queue = [
        ...cleanupPairs.map(c => ({ type: "cleanup", data: c })),
        ...hedgePairs.map(h => ({ type: "hedge", data: h })),
        ...normalPairs.map(p => ({ type: "normal", data: p })),
    ];
    const results = [];
    const workers = [];
    let done = 0;
    for (let i = 0; i < Math.min(concurrentPairs, queue.length); i++) {
        workers.push((async () => {
            while (queue.length) {
                const task = queue.shift();
                if (!task) break;
                let r;
                if (task.type === "cleanup") {
                    r = await processCleanup({
                        exposedWallet: task.data.exposedWallet,
                        exposedPosition: task.data.position,
                        state, today, dryRun,
                    });
                } else if (task.type === "hedge") {
                    r = await processHedge({
                        exposedWallet: task.data.exposedWallet,
                        freeWallet: task.data.freeWallet,
                        exposedPosition: task.data.position,
                        state, today, dryRun,
                    });
                } else {
                    r = await processPair({ pair: task.data, exchangeInfo, tickers, state, today, dryRun });
                }
                results.push(r);
                done++;
                if (done % 10 === 0) {
                    const el = ((Date.now() - t0) / 1000).toFixed(0);
                    console.log(`[${ts()}] 进度 ${done}/${totalPairs} (${el}s)`);
                }
            }
        })());
    }
    await Promise.all(workers);

    if (!dryRun) saveState(stateFile, state);   // 统一保存避免 worker race

    const ok = results.filter(r => r.ok);
    const fail = results.filter(r => !r.ok);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);

    const cleanupOk = ok.filter(r => r.mode === "cleanup");
    const hedgeOk = ok.filter(r => r.mode === "hedge");
    const normalOk = ok.filter(r => !r.mode || (r.mode !== "cleanup" && r.mode !== "hedge"));
    console.log(`\n${"=".repeat(70)}`);
    console.log(`=== 完成 (${elapsed}s) ===`);
    console.log(`任务: ${totalPairs} (${cleanupPairs.length} cleanup + ${hedgePairs.length} hedge + ${normalPairs.length} normal) | 成功: ${ok.length} (${cleanupOk.length} cleanup + ${hedgeOk.length} hedge + ${normalOk.length} normal) | 失败: ${fail.length}`);
    if (fail.length) {
        console.log(`\n失败 pair:`);
        for (const r of fail) console.log(`  [${r.pair?.join(",")}] ${r.mode === "hedge" ? "(hedge)" : ""} ${r.error}`);
    }
    if (ok.length && !dryRun) {
        const allOkIdxs = [...new Set(ok.flatMap(r => r.pair))].sort((a, b) => a - b);
        console.log(`\n!! 这些 pair 现在持仓, 平仓命令:`);
        console.log(`   node cleanup.mjs ${allOkIdxs.join(" ")}`);
    }
}

main().then(() => process.exit(0), e => { console.error("fatal:", e); process.exit(1); });
