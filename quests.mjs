// 查每个钱包的项目方任务积分 (totalQuestPoints + pendingQuestPoints)
//
// 用法:
//   node quests.mjs                       全部钱包, 默认并发 10
//   node quests.mjs 1-100                 钱包 1-100
//   node quests.mjs 11 12 88              指定钱包
//   node quests.mjs --c=20                并发
//   node quests.mjs --details             展开每个 quest 的状态/进度
//   node quests.mjs --pending-only        只列 pending > 0 的钱包
//   node quests.mjs --csv=quests.csv      额外导出 csv (idx, addr, total, pending)
//
// 接口:
//   GET https://x.rho.trading/point-api/v2/users/{address}/quests
//   Bearer = RhoClient.login() 拿到的 access token (跟交易 API 同一个)

import fs from "fs";
import { fileURLToPath } from "url";
import { dirname } from "path";
import axios from "axios";
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

const POINT_BASE = "https://x.rho.trading";

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

async function fetchQuests(token, address, agent) {
    const http = axios.create({
        baseURL: POINT_BASE,
        timeout: 20000,
        httpAgent: agent,
        httpsAgent: agent,
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const url = `/point-api/v2/users/${address.toLowerCase()}/quests`;
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await http.get(url);
            return res.data;
        } catch (e) {
            lastErr = e;
            const status = e.response?.status;
            // 4xx 客户端错 (除 408/429) 不重试
            if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) break;
            if (attempt < 3) await new Promise(r => setTimeout(r, 500 * attempt));
        }
    }
    throw lastErr;
}

function summarize(data) {
    const total = parseFloat(data.totalQuestPoints) || 0;
    const pending = parseFloat(data.pendingQuestPoints) || 0;
    const quests = data.quests || [];
    const byStatus = {};
    for (const q of quests) byStatus[q.status] = (byStatus[q.status] || 0) + 1;

    // 按 code 拿关键任务进度 (项目方 5 markets / week 等核心指标)
    const byCode = {};
    for (const q of quests) byCode[q.code] = q;
    const explorerCount = byCode.market_explorer?.progress?.qualifying_markets?.length ?? 0;
    const explorerTarget = byCode.market_explorer?.progress?.target_markets ?? 5;
    const weeklyVol = parseFloat(byCode.weekly_volume?.progress?.current_volume_usd) || 0;
    const weeklyTgt = parseFloat(byCode.weekly_volume?.progress?.target_volume_usd) || 100000;
    const dailyStreak = byCode.daily_trader?.progress?.currentStreak ?? 0;

    return { total, pending, byStatus, byCode, quests, explorerCount, explorerTarget, weeklyVol, weeklyTgt, dailyStreak };
}

async function processWallet(wallet, idx) {
    const tag = `[${String(idx).padStart(4)}] ${wallet.address.slice(0, 10)}`;
    let client;
    try {
        client = new RhoClient({
            apiBase: config.apiBase,
            privateKey: wallet.privateKey,
            httpAgent: makeAgent(wallet),
        });
        await client.login();
    } catch (e) {
        return { idx, address: wallet.address, ok: false, error: `login: ${errMsg(e)}` };
    }

    let data;
    try {
        data = await fetchQuests(client.token, wallet.address, makeAgent(wallet));
    } catch (e) {
        return { idx, address: wallet.address, ok: false, error: `quests: ${errMsg(e)}` };
    }
    return { idx, address: wallet.address, ok: true, ...summarize(data), raw: data };
}

function fmtUsd(n) {
    return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function main() {
    const args = process.argv.slice(2);
    const details = args.includes("--details");
    const pendingOnly = args.includes("--pending-only");
    const csvPath = parseFlag(args, "csv");
    const concurrency = parseInt(parseFlag(args, "concurrency", "c") || "10");
    if (!Number.isFinite(concurrency) || concurrency < 1 || concurrency > 200) {
        console.log("--concurrency 必须是 1-200 的整数"); process.exit(1);
    }

    const password = await askPassword("请输入解密密码: ");
    let wallets;
    try { wallets = loadWallets(__dirname, password); }
    catch (e) { console.log("解密失败:", e.message); process.exit(1); }

    const selected = parseSelectors(args, wallets.length);
    if (selected) wallets = selected.map(i => ({ ...wallets[i - 1], _origIdx: i }));
    else wallets = wallets.map((w, i) => ({ ...w, _origIdx: i + 1 }));

    console.log(`=== Quest 积分查询 ===`);
    console.log(`钱包: ${wallets.length}${selected ? ` (${selected.slice(0, 20).join(",")}${selected.length > 20 ? "..." : ""})` : " (全部)"} | 并发: ${concurrency}`);
    console.log();

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
                const r = await processWallet(w, w._origIdx);
                results[w._origIdx - 1] = r;
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
    const ok = all.filter(r => r.ok);
    const failed = all.filter(r => !r.ok);

    // 表格输出
    let display = ok;
    if (pendingOnly) display = ok.filter(r => r.pending > 0);
    display = [...display].sort((a, b) => a.idx - b.idx);

    console.log(`${"=".repeat(110)}`);
    console.log(`${"idx".padStart(4)}  ${"address".padEnd(42)}  ${"total".padStart(10)}  ${"pending".padStart(10)}  ${"explorer".padStart(8)}  ${"streak".padStart(6)}  ${"weekly_vol".padStart(12)}`);
    console.log(`${"=".repeat(110)}`);
    let sumTotal = 0, sumPending = 0;
    for (const r of display) {
        sumTotal += r.total;
        sumPending += r.pending;
        const explorer = `${r.explorerCount}/${r.explorerTarget}`;
        console.log(`${String(r.idx).padStart(4)}  ${r.address.padEnd(42)}  ${fmtUsd(r.total).padStart(10)}  ${fmtUsd(r.pending).padStart(10)}  ${explorer.padStart(8)}  ${String(r.dailyStreak).padStart(6)}  ${fmtUsd(r.weeklyVol).padStart(12)}`);
        if (details) {
            for (const q of r.quests) {
                const earned = q.pointsEarned ? `(earned ${q.pointsEarned})` : "";
                console.log(`        ${q.code.padEnd(20)} ${q.status.padEnd(13)} pts=${q.points.padEnd(6)} ${earned}`);
            }
        }
    }
    console.log(`${"=".repeat(110)}`);
    console.log(`${"SUM".padStart(4)}  ${"".padEnd(42)}  ${fmtUsd(sumTotal).padStart(10)}  ${fmtUsd(sumPending).padStart(10)}  钱包数 ${display.length}`);

    // 状态分布 (诊断哪些钱包停在 not_started / in_progress)
    const statusCounts = {};
    const codeStatusCounts = {};
    for (const r of ok) {
        for (const q of r.quests) {
            statusCounts[q.status] = (statusCounts[q.status] || 0) + 1;
            const k = `${q.code}|${q.status}`;
            codeStatusCounts[k] = (codeStatusCounts[k] || 0) + 1;
        }
    }
    console.log(`\n--- 总体状态分布 (status 计数, 全部 ${ok.length} 钱包 × ~6 quests) ---`);
    for (const [s, c] of Object.entries(statusCounts).sort((a,b)=>b[1]-a[1])) console.log(`  ${s.padEnd(15)}: ${c}`);

    console.log(`\n--- 各任务状态分布 ---`);
    const codes = [...new Set(Object.keys(codeStatusCounts).map(k => k.split("|")[0]))];
    for (const code of codes) {
        const parts = [];
        for (const [k, c] of Object.entries(codeStatusCounts)) {
            if (k.startsWith(code + "|")) parts.push(`${k.split("|")[1]}=${c}`);
        }
        console.log(`  ${code.padEnd(20)}: ${parts.join("  ")}`);
    }

    if (failed.length) {
        console.log(`\n失败钱包 ${failed.length}:`);
        for (const f of failed.sort((a,b)=>a.idx-b.idx)) {
            console.log(`  [${String(f.idx).padStart(4)}] ${f.address}  ${f.error}`);
        }
        console.log(`\n失败钱包重跑命令:`);
        console.log(`  node quests.mjs ${failed.map(f => f.idx).join(" ")}`);
    }

    if (csvPath) {
        const lines = ["idx,address,total,pending,explorer_qualifying,explorer_target,weekly_vol,daily_streak,error"];
        for (const r of all.sort((a,b)=>a.idx-b.idx)) {
            if (r.ok) {
                lines.push(`${r.idx},${r.address},${r.total},${r.pending},${r.explorerCount},${r.explorerTarget},${r.weeklyVol},${r.dailyStreak},`);
            } else {
                lines.push(`${r.idx},${r.address},,,,,,,${JSON.stringify(r.error)}`);
            }
        }
        fs.writeFileSync(csvPath, lines.join("\n") + "\n");
        console.log(`\nCSV 已写到 ${csvPath}`);
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    console.log(`\n完成 (${elapsed}s)`);
}

main().then(
    () => process.exit(0),
    e => { console.error("fatal:", e); process.exit(1); }
);
