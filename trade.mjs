import fs from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { HttpsProxyAgent } from "https-proxy-agent";

import { askPassword, loadWallets } from "./lib/cipher.mjs";
import { RhoClient, fetchExchangeInfo } from "./lib/rho.mjs";
import { loadState, saveState, dayKey, getRun, setRun, summary } from "./lib/state.mjs";
import { getStrategy } from "./strategies/index.mjs";
import { createShutdownSignal, computeNextRun, sleepUntil, fmtDuration } from "./lib/scheduler.mjs";
import { config } from "./config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const ts = () => new Date().toISOString().slice(11, 19);
const fmtTime = d => d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
const errMsg = e => e?.response ? `${e.response.status} ${JSON.stringify(e.response.data).slice(0, 300)}` : e?.message;

// 每钱包自己的代理 (从 wallets.csv 的 proxyHost/proxyPort/proxyUsername/proxyPassword)
function makeAgent(wallet) {
    if (!config.useProxy) return null;
    const p = wallet.proxy;
    if (!p) return null;
    const auth = p.username ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@` : "";
    return new HttpsProxyAgent(`http://${auth}${p.host}:${p.port}`);
}

async function buildClient(wallet) {
    const c = new RhoClient({
        apiBase: config.apiBase,
        privateKey: wallet.privateKey,
        httpAgent: makeAgent(wallet),
    });
    await c.login();
    return c;
}

// 智能 cleanup: 只扫今日候选 (该策略今日不是 ok 状态的)
async function cleanupCandidates(candidates, today, stratName, state) {
    if (!config.cleanupOnStart) return { closed: 0, errors: 0 };
    if (!candidates.length) return { closed: 0, errors: 0 };
    console.log(`[${ts()}] === cleanup phase: 检查 ${candidates.length} 个候选钱包遗留仓位 ===`);
    let closed = 0, errors = 0;
    const queue = [...candidates];
    const limit = Math.min(config.concurrency, queue.length);
    const workers = [];
    for (let i = 0; i < limit; i++) {
        workers.push((async () => {
            while (queue.length) {
                const w = queue.shift();
                if (!w) break;
                const tag = `[${w.address.slice(0, 10)}]`;
                let client;
                try { client = await buildClient(w); }
                catch (e) { console.log(`[${ts()}] ${tag} cleanup login err: ${errMsg(e)}`); errors++; continue; }
                let positions;
                try { positions = (await client.getPositions()).positions ?? []; }
                catch (e) { console.log(`[${ts()}] ${tag} cleanup positions err: ${errMsg(e)}`); errors++; continue; }
                const open = positions.filter(p => parseFloat(p.notional) !== 0);
                for (const p of open) {
                    const cid = `cl${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.slice(0, 36);
                    try {
                        await client.createOrder({
                            orderType: "market", symbol: p.symbol, timeInForce: "IOC",
                            flags: ["close-position"], clientOrderId: cid,
                        });
                        console.log(`[${ts()}] ${tag} cleanup: 平 ${p.symbol} notional=${p.notional}`);
                        closed++;
                    } catch (e) {
                        console.log(`[${ts()}] ${tag} cleanup close ${p.symbol} err: ${errMsg(e)}`);
                        errors++;
                    }
                }
            }
        })());
    }
    await Promise.all(workers);
    console.log(`[${ts()}] === cleanup 完成: 已平 ${closed} | 错误 ${errors} ===\n`);
    return { closed, errors };
}

async function runPerWallet({ wallet, strategy, exchangeInfo, state, today, dayBoundary }) {
    const tag = `[${wallet.address.slice(0, 10)}]`;
    const log = msg => console.log(`[${ts()}] ${tag} ${msg}`);
    let client;
    try { client = await buildClient(wallet); log("login ok"); }
    catch (e) { log(`login 失败: ${errMsg(e)}`); return { ok: false, error: `login: ${errMsg(e)}` }; }
    if (config.dryRun) { log("[DRY] 跳过实际下单 (config.dryRun=true)"); return { ok: false, error: "dryRun" }; }
    try {
        const r = await strategy.execute(client, { wallet, log, config, exchangeInfo, state, today, dayBoundary });
        if (r.ok) log(`✓ 完成 ${r.symbol} pnl(net)=${r.pnl?.net} positionsClean=${r.positionsClean}`);
        else log(`✗ 失败: ${r.error}`);
        return r;
    } catch (e) {
        log(`✗ 异常: ${errMsg(e)}`);
        return { ok: false, error: `异常: ${errMsg(e)}` };
    }
}

async function runStrategy({ strategy, stratName, wallets, exchangeInfo, state, today, stateFile, shutdown }) {
    const candidates = [];
    let skipped = 0;
    for (const w of wallets) {
        const r = getRun(state, w.address, today, stratName);
        if (r?.status === "ok") { skipped++; continue; }
        if (r?.status === "failed" && !config.retryFailed) { skipped++; continue; }
        candidates.push(w);
    }
    console.log(`[${ts()}] 今日 ${today} (TZ=${config.dayBoundary || "local"}) | 策略=${stratName} (${strategy.meta?.type})`);
    console.log(`[${ts()}] 钱包总数: ${wallets.length} | 今日已完成跳过: ${skipped} | 候选: ${candidates.length}`);
    if (!candidates.length) { console.log(`[${ts()}] 无候选钱包, 跳过本轮\n`); return { ok: 0, fail: 0 }; }
    if (config.dryRun) { console.log(`[${ts()}] dryRun=true, 跳过实际执行\n`); return { ok: 0, fail: 0 }; }

    // cleanup 仅候选, 节省 1000 钱包扫描成本
    await cleanupCandidates(candidates, today, stratName, state);

    if (strategy.meta?.type === "group") {
        const log = msg => console.log(`[${ts()}] [group] ${msg}`);
        const results = await strategy.executeGroup({
            candidates, getClient: w => buildClient(w),
            exchangeInfo, config, log,
            state, today, dayBoundary: config.dayBoundary,
        });
        for (const r of results) {
            setRun(state, r.address, today, stratName, r.record);
            saveState(stateFile, state);
        }
        const ok = results.filter(r => r.record.status === "ok").length;
        return { ok, fail: results.length - ok };
    } else {
        const tasks = [...candidates];
        const workers = [];
        let ok = 0, fail = 0, done = 0;
        const total = tasks.length;
        for (let i = 0; i < Math.min(config.concurrency, tasks.length); i++) {
            workers.push((async () => {
                while (tasks.length) {
                    if (shutdown?.requested) return;
                    const w = tasks.shift();
                    if (!w) break;
                    const r = await runPerWallet({ wallet: w, strategy, exchangeInfo, state, today, dayBoundary: config.dayBoundary });
                    setRun(state, w.address, today, stratName, {
                        strategy: stratName,
                        status: r.ok ? "ok" : "failed",
                        ts: new Date().toISOString(),
                        ...r,
                    });
                    saveState(stateFile, state);
                    if (r.ok) ok++; else fail++;
                    done++;
                    if (done % 50 === 0) console.log(`[${ts()}] 进度 ${done}/${total} (ok=${ok} fail=${fail})`);
                }
            })());
        }
        await Promise.all(workers);
        return { ok, fail };
    }
}

async function runOneCycle({ strategy, stratName, wallets, state, stateFile, shutdown }) {
    const cycleStart = Date.now();
    const today = dayKey(new Date(), config.dayBoundary || "local");

    let exchangeInfo;
    try {
        exchangeInfo = await fetchExchangeInfo(config.apiBase);
        console.log(`[${ts()}] exchange/info: ${exchangeInfo.symbols?.length} 个 symbol`);
    } catch (e) { console.log(`[${ts()}] exchange/info 失败 (本轮放弃): ${errMsg(e)}`); return; }

    const r = await runStrategy({ strategy, stratName, wallets, exchangeInfo, state, today, stateFile, shutdown });
    const elapsed = Date.now() - cycleStart;
    const s = summary(state, today, stratName);
    console.log(`[${ts()}] 本轮: 成功 ${r.ok} | 失败 ${r.fail} | 用时 ${fmtDuration(elapsed)}`);
    console.log(`[${ts()}] 今日累计 ${stratName}: ok ${s.ok} | failed ${s.failed} | 钱包数 ${s.addresses}\n`);
}

async function daemon({ strategy, stratName, wallets, state, stateFile, shutdown }) {
    const sched = config.schedule;

    while (!shutdown.requested) {
        // 是否需要立即跑: 今日还没全部 ok
        const today = dayKey(new Date(), config.dayBoundary || "local");
        const s = summary(state, today, stratName);
        const todayDone = s.addresses > 0 && s.addresses === s.ok;

        if (!todayDone) {
            console.log(`[${ts()}] === 启动/补跑 cycle (today=${today}) ===`);
            try { await runOneCycle({ strategy, stratName, wallets, state, stateFile, shutdown }); }
            catch (e) { console.error(`[${ts()}] cycle 异常 (已隔离, 进程继续):`, e); }
        } else {
            console.log(`[${ts()}] 今日 ${today} 已全部完成 (ok=${s.ok}/${s.addresses}), 跳过`);
        }

        if (shutdown.requested) break;

        const next = computeNextRun(new Date(), sched.hourLocal, sched.minuteLocal, sched.jitterMinutes);
        const remaining = next.getTime() - Date.now();
        console.log(`[${ts()}] 下次触发: ${fmtTime(next)} (~${fmtDuration(remaining)} 后)`);
        await sleepUntil(next, sched.pollIntervalSeconds * 1000, shutdown);
    }

    console.log(`[${ts()}] daemon 退出 (reason=${shutdown.reason})`);
}

// 钱包选择器: "1" / "1-3" / "10 17" / "1-3 10 17"; 不传 = 全部
function parseSelectors(args, max) {
    const tokens = args.flatMap(a => String(a).split(/\s+/)).filter(Boolean);
    if (!tokens.length) return null;
    const set = new Set();
    for (const t of tokens) {
        const m = t.match(/^(\d+)(?:-(\d+))?$/);
        if (!m) { console.log(`无法识别 selector "${t}"`); process.exit(1); }
        const a = parseInt(m[1]);
        const b = m[2] ? parseInt(m[2]) : a;
        if (a < 1 || b < a || a > max) { console.log(`范围 ${t} 无效, 共 ${max} 个钱包`); process.exit(1); }
        for (let i = a; i <= Math.min(b, max); i++) set.add(i);
    }
    return [...set].sort((x, y) => x - y);
}

async function main() {
    const args = process.argv.slice(2);
    const flags = new Set(args.filter(a => a.startsWith("--")));
    const positional = args.filter(a => !a.startsWith("--"));

    // 第一个位置参数: 如果不像数字, 当作策略名; 否则当作钱包选择器
    let stratName = config.strategy;
    let selectorTokens = positional;
    if (positional[0] && !/^\d/.test(positional[0])) {
        stratName = positional[0];
        selectorTokens = positional.slice(1);
    }

    // 默认: 有 selector → 一次性 (像手动测试); 无 selector → daemon (批量长跑)
    // 显式 --once / --daemon 覆盖默认
    const explicitOnce = flags.has("--once");
    const explicitDaemon = flags.has("--daemon");
    const hasSelector = selectorTokens.length > 0;
    const runOnce = explicitOnce || (!explicitDaemon && hasSelector);

    const strategy = getStrategy(stratName);

    console.log(`=== Rho-X 自动交易${runOnce ? " (一次性)" : " daemon"} / 策略: ${stratName} (${strategy.meta?.type}) ===`);
    if (!runOnce) {
        console.log(`schedule: 每天 ${String(config.schedule.hourLocal).padStart(2, "0")}:${String(config.schedule.minuteLocal).padStart(2, "0")} (本地) +0..${config.schedule.jitterMinutes}m jitter`);
    }
    console.log("");

    const password = await askPassword("请输入解密密码: ");
    let wallets;
    try { wallets = loadWallets(__dirname, password); }
    catch (e) { console.log("解密失败:", e.message); process.exit(1); }
    console.log(`[${ts()}] 解密 ${wallets.length} 个钱包成功`);

    // 应用钱包选择器 (1-indexed)
    const selected = parseSelectors(selectorTokens, wallets.length);
    if (selected) {
        wallets = selected.map(i => wallets[i - 1]);
        console.log(`[${ts()}] 按 selector 筛选: ${selected.join(",")}`);
    }

    const stateFile = join(__dirname, config.stateFile);
    const state = loadState(stateFile);
    const shutdown = createShutdownSignal();
    shutdown.onSignal(() => saveState(stateFile, state));

    const withProxy = wallets.filter(w => w.proxy).length;
    console.log(`[${ts()}] 钱包 ${wallets.length} (${withProxy} 个有 proxy) | 并发 ${config.concurrency} | useProxy=${config.useProxy} | dryRun=${config.dryRun}`);
    console.log(`[${ts()}] 状态文件: ${stateFile}`);
    console.log(`[${ts()}] 按 Ctrl+C 优雅退出 (会等当前 cycle 结束)\n`);

    if (runOnce) {
        // 一次性: 立刻跑一轮就退出
        try { await runOneCycle({ strategy, stratName, wallets, state, stateFile, shutdown }); }
        catch (e) { console.error(`[${ts()}] cycle 异常:`, e); }
    } else {
        await daemon({ strategy, stratName, wallets, state, stateFile, shutdown });
    }

    saveState(stateFile, state);
    console.log(`[${ts()}] state 已保存, exit 0`);
    process.exit(0);
}

main().catch(e => { console.error("fatal:", e); process.exit(1); });
