// 全钱包持仓清理: 登录每个钱包 → 查 positions → close-position 关掉所有非零仓位
//
// 用法:
//   node cleanup.mjs                       全部 1000 钱包, 默认并发 10
//   node cleanup.mjs 1-100                 钱包 1-100
//   node cleanup.mjs 11 12 88              指定钱包
//   node cleanup.mjs --c=20                并发 20
//   node cleanup.mjs --dry-run             只查不平 (确认有 orphan 再跑实盘)
//   node cleanup.mjs --yes                 跳过 yes 确认 (cron / 脚本场景)
//
// 安全:
//   - close-position flag 由服务端按当前持仓自动反向, 不会"反手开"
//   - 若钱包当前 positions 全是 0, 该钱包跳过, 不发 tx, 0 fee
//   - 失败钱包末尾打表, 给出重跑命令
//   - process.on(unhandledRejection) 兜底, 进程不会崩

import { fileURLToPath } from "url";
import { dirname } from "path";
import readline from "readline";
import { HttpsProxyAgent } from "https-proxy-agent";
import { askPassword, loadWallets } from "./lib/cipher.mjs";
import { RhoClient } from "./lib/rho.mjs";
import { config } from "./config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

process.on("unhandledRejection", (r) => {
    console.warn(`[unhandledRejection 已忽略] ${r?.message?.slice(0, 200) || r}`);
});
process.on("uncaughtException", (e) => {
    console.warn(`[uncaughtException 已忽略] ${e?.message?.slice(0, 200) || e}`);
});

const ts = () => new Date().toISOString().slice(11, 19);
const errMsg = e => e?.response
    ? `${e.response.status} ${JSON.stringify(e.response.data).slice(0, 200)}`
    : (e?.shortMessage || e?.message || String(e));

function makeAgent(wallet) {
    if (!config.useProxy) return null;
    const p = wallet.proxy;
    if (!p) return null;
    const auth = p.username
        ? `${encodeURIComponent(p.username)}:${encodeURIComponent(p.password)}@`
        : "";
    return new HttpsProxyAgent(`http://${auth}${p.host}:${p.port}`);
}

function parseSelectors(args, max) {
    const tokens = args.filter(a => !a.startsWith("--"))
        .flatMap(a => String(a).split(/\s+/)).filter(Boolean);
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
    return [...set].sort((a, b) => a - b);
}

function parseFlag(args, ...names) {
    for (const a of args) {
        for (const n of names) {
            const m = a.match(new RegExp(`^--${n}=(.+)$`));
            if (m) return m[1];
        }
    }
    return null;
}

async function processWallet(wallet, idx, dryRun) {
    const tag = `[${idx}] ${wallet.address.slice(0, 10)}`;
    const log = m => console.log(`[${ts()}] ${tag} ${m}`);

    // 1. login
    let client;
    try {
        client = new RhoClient({
            apiBase: config.apiBase,
            privateKey: wallet.privateKey,
            httpAgent: makeAgent(wallet),
        });
        await client.login();
    } catch (e) {
        log(`login 失败: ${errMsg(e)}`);
        return { ok: false, reason: "login", positions: 0, closed: 0, error: errMsg(e) };
    }

    // 2. 查持仓
    let positions;
    try {
        positions = (await client.getPositions()).positions ?? [];
    } catch (e) {
        log(`getPositions 失败: ${errMsg(e)}`);
        return { ok: false, reason: "positions", positions: 0, closed: 0, error: errMsg(e) };
    }

    const open = positions.filter(p => parseFloat(p.notional) !== 0);
    if (open.length === 0) {
        return { ok: true, positions: 0, closed: 0 };
    }

    log(`发现 ${open.length} 个未平仓位:`);
    for (const p of open) {
        log(`    ${p.symbol} dir=${p.riskDirection} notional=${p.notional} avgPx=${p.avgPrice}`);
    }

    if (dryRun) {
        log(`[DRY] 跳过 close-position`);
        return { ok: true, positions: open.length, closed: 0, dry: true, items: open.map(p => p.symbol) };
    }

    // 3. 平仓
    let closedCount = 0, errCount = 0;
    const failedItems = [];
    for (const p of open) {
        const cid = `cl${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`.slice(0, 36);
        try {
            const r = await client.createOrder({
                orderType: "market",
                symbol: p.symbol,
                timeInForce: "IOC",
                flags: ["close-position"],
                clientOrderId: cid,
            });
            const tr = r.trades?.[0];
            log(`  ✓ closed ${p.symbol} fill=${tr?.price}@${tr?.volume} fee=${tr?.tradingFees}`);
            closedCount++;
        } catch (e) {
            log(`  ✗ close ${p.symbol} 失败: ${errMsg(e)}`);
            errCount++;
            failedItems.push(p.symbol);
        }
    }
    return {
        ok: errCount === 0,
        positions: open.length,
        closed: closedCount,
        errors: errCount,
        failedItems,
    };
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
    const concurrency = parseInt(parseFlag(args, "concurrency", "c") || "10");
    if (!Number.isFinite(concurrency) || concurrency < 1 || concurrency > 200) {
        console.log("--concurrency 必须是 1-200 的整数"); process.exit(1);
    }

    const password = await askPassword("请输入解密密码: ");
    let wallets;
    try { wallets = loadWallets(__dirname, password); }
    catch (e) { console.log("解密失败:", e.message); process.exit(1); }

    const selected = parseSelectors(args, wallets.length);
    if (selected) {
        wallets = selected.map(i => ({ ...wallets[i - 1], _origIdx: i }));
    } else {
        wallets = wallets.map((w, i) => ({ ...w, _origIdx: i + 1 }));
    }

    console.log(`=== Cleanup ${dryRun ? "(DRY-RUN)" : "实盘"} ===`);
    console.log(`钱包: ${wallets.length}${selected ? ` (${selected.join(",")})` : " (全部)"} | 并发: ${concurrency}`);

    if (!dryRun && !skipConfirm) {
        const ok = await confirm(`将对 ${wallets.length} 个钱包扫持仓并 close-position 平仓. 确认? (yes/no) `);
        if (!ok) { console.log("取消"); return; }
    }

    const t0 = Date.now();
    const queue = [...wallets];
    const results = new Array(wallets.length);
    let done = 0;
    const workers = [];
    for (let i = 0; i < Math.min(concurrency, wallets.length); i++) {
        workers.push((async () => {
            while (queue.length) {
                const w = queue.shift();
                if (!w) break;
                const r = await processWallet(w, w._origIdx, dryRun);
                results[w._origIdx - 1] = { idx: w._origIdx, address: w.address, ...r };
                done++;
                if (done % 50 === 0) {
                    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
                    console.log(`[${ts()}] 进度 ${done}/${wallets.length} (${elapsed}s)`);
                }
            }
        })());
    }
    await Promise.all(workers);

    const all = results.filter(Boolean);
    const totalPositions = all.reduce((a, b) => a + (b.positions || 0), 0);
    const totalClosed = all.reduce((a, b) => a + (b.closed || 0), 0);
    const failedWallets = all.filter(r => !r.ok);
    const walletsWithPos = all.filter(r => r.positions > 0);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);

    console.log(`\n${"=".repeat(70)}`);
    console.log(`=== 完成 (${elapsed}s) ===`);
    console.log(`钱包总数:           ${all.length}`);
    console.log(`有持仓的钱包数:     ${walletsWithPos.length}`);
    console.log(`持仓总数:           ${totalPositions}`);
    if (!dryRun) console.log(`成功 close 的:      ${totalClosed}`);
    console.log(`失败钱包:           ${failedWallets.length}`);

    if (walletsWithPos.length > 0) {
        console.log(`\n--- 有持仓的钱包明细 (按 idx 排序) ---`);
        for (const r of walletsWithPos.sort((a, b) => a.idx - b.idx)) {
            const status = dryRun ? "🔍" : (r.closed === r.positions ? "✓" : (r.closed > 0 ? "⚠️" : "✗"));
            const items = r.items ? ` [${r.items.join(", ")}]` : "";
            console.log(`  ${status} [${String(r.idx).padStart(4)}] ${r.address}  positions=${r.positions} closed=${r.closed}${items}`);
        }
    }

    if (failedWallets.length > 0) {
        const idxs = failedWallets.map(r => r.idx).join(" ");
        console.log(`\n失败钱包重跑命令:`);
        console.log(`  node cleanup.mjs ${idxs}`);
        console.log(`\n失败明细:`);
        for (const f of failedWallets.sort((a, b) => a.idx - b.idx)) {
            console.log(`  [${String(f.idx).padStart(4)}] ${f.address}  reason=${f.reason || "?"}  ${f.error || ""}`);
        }
    }
}

main().then(
    () => process.exit(0),
    e => { console.error("fatal:", e); process.exit(1); }
);
