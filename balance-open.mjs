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

function selectSymbolForPair({ exchangeInfo, tickers, notional, pairTradedUnion }) {
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

    // 多样性: pair union 没碰过的 market 优先
    const minDistinct = cfg.minDistinctMarketsPerWeek ?? 3;
    if (pairTradedUnion.size < minDistinct) {
        const untraded = candidates.filter(s => !pairTradedUnion.has(symbolToMarket(s.symbol)));
        if (untraded.length > 0) candidates = untraded;
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

async function processPair({ pair, exchangeInfo, tickers, state, today, dryRun }) {
    const [a, b] = pair;
    const tag = `[${a.idx}+${b.idx}]`;
    const log = m => console.log(`[${ts()}] ${tag} ${m}`);

    const lookback = config.instant.lookbackDays ?? 7;
    const trA = tradedMarketsFor(state, a.address, today, lookback, config.dayBoundary);
    const trB = tradedMarketsFor(state, b.address, today, lookback, config.dayBoundary);
    const union = new Set([...trA, ...trB]);
    log(`pair union markets (${union.size}): [${[...union].join(", ")}]`);

    const notional = pickNotional();
    const sym = selectSymbolForPair({ exchangeInfo, tickers, notional, pairTradedUnion: union });
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

    const shuffled = shuffle(wallets);
    const pairs = [];
    for (let i = 0; i + 1 < shuffled.length; i += 2) {
        pairs.push([shuffled[i], shuffled[i + 1]]);
    }
    const dropped = wallets.length % 2 === 1 ? shuffled[shuffled.length - 1] : null;

    console.log(`=== 配平开仓 (balance-open) ${dryRun ? "(DRY-RUN)" : "实盘"} ===`);
    console.log(`钱包: ${wallets.length} | pair: ${pairs.length}${dropped ? ` | 落单: idx=${dropped.idx}` : ""} | 并发 pair: ${concurrentPairs}`);
    console.log(`notional: [${config.instant.notionalUsdRange.join(", ")}] (复用 instant)`);
    console.log(`市场不重复: pair union < ${config.instant.minDistinctMarketsPerWeek} 时强制选未交易过的 market`);
    console.log(`!! 配平开仓后不平仓, 由你手动 cleanup.mjs / trade.mjs cleanupOnStart 平掉\n`);

    if (!dryRun && !skipConfirm) {
        const ok = await confirm(`将开 ${pairs.length} 对仓位, 确认? (yes/no) `);
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

    const stateFile = join(__dirname, config.stateFile);
    const state = loadState(stateFile);
    const today = dayKey(new Date(), config.dayBoundary || "local");

    const t0 = Date.now();
    const queue = [...pairs];
    const results = [];
    const workers = [];
    let done = 0;
    for (let i = 0; i < Math.min(concurrentPairs, queue.length); i++) {
        workers.push((async () => {
            while (queue.length) {
                const pair = queue.shift();
                if (!pair) break;
                const r = await processPair({ pair, exchangeInfo, tickers, state, today, dryRun });
                results.push(r);
                done++;
                if (done % 10 === 0) {
                    const el = ((Date.now() - t0) / 1000).toFixed(0);
                    console.log(`[${ts()}] 进度 ${done}/${pairs.length} (${el}s)`);
                }
            }
        })());
    }
    await Promise.all(workers);

    if (!dryRun) saveState(stateFile, state);   // 统一保存避免 worker race

    const ok = results.filter(r => r.ok);
    const fail = results.filter(r => !r.ok);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);

    console.log(`\n${"=".repeat(70)}`);
    console.log(`=== 完成 (${elapsed}s) ===`);
    console.log(`Pair: ${pairs.length} | 成功: ${ok.length} | 失败: ${fail.length}`);
    if (fail.length) {
        console.log(`\n失败 pair:`);
        for (const r of fail) console.log(`  [${r.pair?.join(",")}] ${r.error}`);
    }
    if (ok.length && !dryRun) {
        const allOkIdxs = [...new Set(ok.flatMap(r => r.pair))].sort((a, b) => a - b);
        console.log(`\n!! 这些 pair 现在持仓, 平仓命令:`);
        console.log(`   node cleanup.mjs ${allOkIdxs.join(" ")}`);
    }
}

main().then(() => process.exit(0), e => { console.error("fatal:", e); process.exit(1); });
