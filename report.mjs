// 资金汇总报告: 每钱包链上 ETH/USDT + Rho funding 账户 + 积分 (totalPoints + pending quest), 输出 CSV
//
// 用法:
//   node report.mjs                       全部钱包 (默认输出 report-YYYYMMDD-HHMMSS.csv)
//   node report.mjs 1-100                 钱包 1-100
//   node report.mjs --c=15                并发 (默认 10)
//   node report.mjs --out=report.csv      指定输出文件 → append/merge 模式:
//                                            - 文件不存在: 新建写入
//                                            - 文件存在 + header 一致: 按 idx 合并, 新数据覆盖旧
//                                            - header 不一致: 旧文件备份 .bak, 写新
//
// CSV 列:
//   idx,address,eth,usdt,
//   funding_total,withdrawable,initialMargin,pnl,fees,openPositions,
//   rank,totalPoints,lastPeriodPoints,totalQuestPoints,pendingQuestPoints,
//   error
//
// 接口:
//   api.x.rho.trading/api/v1/margin-accounts          → funding/pnl/fees
//   api.x.rho.trading/api/v1/users/positions          → 持仓数
//   x.rho.trading/point-api/v2/leaderboard/user       → totalPoints/rank
//   x.rho.trading/point-api/v2/users/{addr}/quests    → totalQuestPoints/pendingQuestPoints

import fs from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { Wallet, Contract, formatUnits, formatEther } from "ethers";
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { askPassword, loadWallets } from "./lib/cipher.mjs";
import { buildProvider } from "./lib/rpc.mjs";
import { config } from "./config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

process.on("unhandledRejection", r => console.warn(`[unhandledRejection] ${r?.message?.slice(0, 200) || r}`));
process.on("uncaughtException", e => console.warn(`[uncaughtException] ${e?.message?.slice(0, 200) || e}`));

const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
];

const ts = () => new Date().toISOString().slice(11, 19);
const errMsg = e => e?.response
    ? `${e.response.status} ${JSON.stringify(e.response.data).slice(0, 200)}`
    : (e?.shortMessage || e?.message || String(e));

const POINT_BASE = "https://x.rho.trading";

function makeAxiosWith(baseURL, walletProxy) {
    const cfg = { baseURL, timeout: 30000 };
    if (config.useProxy && walletProxy) {
        const auth = walletProxy.username
            ? `${encodeURIComponent(walletProxy.username)}:${encodeURIComponent(walletProxy.password)}@`
            : "";
        const a = new HttpsProxyAgent(`http://${auth}${walletProxy.host}:${walletProxy.port}`);
        cfg.httpAgent = a; cfg.httpsAgent = a;
    }
    return axios.create(cfg);
}

const makeAxios = wp => makeAxiosWith(config.apiBase, wp);
const makePointAxios = wp => makeAxiosWith(POINT_BASE, wp);

async function rhoLogin(http, w) {
    const wallet = new Wallet(w.privateKey);
    const n = await http.post("/auth-api/v1/nonce", { address: wallet.address });
    const sig = await wallet.signMessage(n.data.messageToSign);
    const l = await http.post("/auth-api/v1/login", { address: wallet.address, signature: sig, type: "evm" });
    if (!l.data.token) throw new Error("login 无 token");
    return { headers: { Authorization: `Bearer ${l.data.token}` } };
}

// 通用重试: 默认 3 次, 指数退避 500/1000/2000ms
// 4xx 客户端错 (404 等) 不重试; 5xx / 408 / 429 / 网络错 重试
async function retry(fn, attempts = 3, baseMs = 500, label = "") {
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
        try { return await fn(); }
        catch (e) {
            lastErr = e;
            const status = e?.response?.status;
            const retriable = !status                                // 网络错 (ECONNRESET 等)
                || status === 408 || status === 429                  // 客户端 timeout / ratelimit
                || (status >= 500 && status < 600);                  // 5xx
            if (!retriable || i === attempts) throw e;
            const delay = baseMs * i;
            if (label) console.warn(`[${ts()}] ${label} #${i} 失败 (${status || "net"}): ${errMsg(e).slice(0, 60)}, ${delay}ms 后重试`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastErr;
}

async function queryOnchain(w) {
    return retry(async () => {
        const rpcProxy = (config.deposit.rpcUseProxy ?? false) ? w.proxy : null;
        const provider = buildProvider(config.deposit.ethRpcUrls ?? config.deposit.ethRpcUrl, rpcProxy, w.address);
        const usdt = new Contract(config.deposit.usdt, ERC20_ABI, provider);
        const [eth, ub, decimals] = await Promise.all([
            provider.getBalance(w.address),
            usdt.balanceOf(w.address),
            usdt.decimals(),
        ]);
        return { eth: formatEther(eth), usdt: formatUnits(ub, decimals) };
    }, 3, 1000, `onchain[${w.address.slice(0, 10)}]`);
}

async function queryRho(w) {
    const http = makeAxios(w.proxy);
    const point = makePointAxios(w.proxy);
    const tag = w.address.slice(0, 10);

    // login 加重试 (网络 / nonce race)
    const auth = await retry(() => rhoLogin(http, w), 3, 500, `login[${tag}]`);
    const H = { headers: auth.headers };
    const addr = w.address.toLowerCase();

    // 4 个接口各自重试 + allSettled (任一最终失败不影响其他)
    const [maR, posR, questsR, leaderR] = await Promise.allSettled([
        retry(() => http.get("/api/v1/margin-accounts", H), 3, 500, `margin[${tag}]`),
        retry(() => http.get("/api/v1/users/positions", H), 3, 500, `pos[${tag}]`),
        retry(() => point.get(`/point-api/v2/users/${addr}/quests`, H), 3, 500, `quests[${tag}]`),
        retry(() => point.get(`/point-api/v2/leaderboard/user?userId=${addr}`, H), 3, 500, `leader[${tag}]`),
    ]);

    const out = {
        funding_total: "0", withdrawable: "0", initialMargin: "0", pnl: "0", fees: "0", openPositions: 0,
        rank: "", totalPoints: "0", lastPeriodPoints: "0", totalQuestPoints: "0", pendingQuestPoints: "0",
    };
    const errs = [];

    if (maR.status === "fulfilled") {
        const fa = maR.value.data.userMarginAccounts?.find(a => a.marginAccount === "funding");
        if (fa) {
            out.funding_total = fa.totalMargin ?? "0";
            out.withdrawable = fa.withdrawableBalance ?? "0";
            out.initialMargin = fa.initialMarginRequirement ?? "0";
            out.pnl = fa.totalPnl ?? "0";
            out.fees = fa.tradingFees ?? "0";
        }
    } else errs.push(`margin: ${errMsg(maR.reason).slice(0, 60)}`);

    if (posR.status === "fulfilled") {
        const positions = posR.value.data.positions ?? [];
        out.openPositions = positions.filter(p => parseFloat(p.notional) !== 0).length;
    } else errs.push(`pos: ${errMsg(posR.reason).slice(0, 60)}`);

    if (questsR.status === "fulfilled") {
        out.totalQuestPoints = questsR.value.data.totalQuestPoints ?? "0";
        out.pendingQuestPoints = questsR.value.data.pendingQuestPoints ?? "0";
    } else errs.push(`quests: ${errMsg(questsR.reason).slice(0, 60)}`);

    if (leaderR.status === "fulfilled") {
        out.rank = leaderR.value.data.rank ?? "";
        out.totalPoints = leaderR.value.data.totalPoints ?? "0";
        out.lastPeriodPoints = leaderR.value.data.lastPeriodPoints ?? "0";
    } else {
        // leaderboard 对新钱包常常 404, 不算硬错
        const status = leaderR.reason?.response?.status;
        if (status !== 404) errs.push(`leader: ${errMsg(leaderR.reason).slice(0, 60)}`);
    }

    if (errs.length) out._rhoErr = errs.join(" | ");
    return out;
}

async function processWallet(w, idx) {
    const tag = `[${String(idx).padStart(4)}] ${w.address.slice(0, 10)}`;
    let onchain = { eth: "?", usdt: "?" };
    let rho = {
        funding_total: "?", withdrawable: "?", initialMargin: "?", pnl: "?", fees: "?", openPositions: "?",
        rank: "", totalPoints: "?", lastPeriodPoints: "?", totalQuestPoints: "?", pendingQuestPoints: "?",
    };
    const errs = [];

    const [onR, rhR] = await Promise.allSettled([queryOnchain(w), queryRho(w)]);
    if (onR.status === "fulfilled") onchain = onR.value;
    else errs.push(`onchain: ${errMsg(onR.reason).slice(0, 80)}`);
    if (rhR.status === "fulfilled") {
        rho = rhR.value;
        if (rho._rhoErr) errs.push(rho._rhoErr);
        delete rho._rhoErr;
    } else errs.push(`rho: ${errMsg(rhR.reason).slice(0, 80)}`);

    const error = errs.join(" | ");
    console.log(`[${ts()}] ${tag}  ETH=${onchain.eth}  USDT=${onchain.usdt}  funding=${rho.funding_total}  pnl=${rho.pnl}  pts=${rho.totalPoints}  pendingQ=${rho.pendingQuestPoints}  pos=${rho.openPositions}${error ? "  ✗ " + error : ""}`);
    return { idx, address: w.address, ...onchain, ...rho, error };
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
        if (a < 1 || b < a || a > max) { console.log(`范围 ${t} 无效`); process.exit(1); }
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

function fmtTs() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}-${String(d.getHours()).padStart(2,"0")}${String(d.getMinutes()).padStart(2,"0")}${String(d.getSeconds()).padStart(2,"0")}`;
}

async function main() {
    const args = process.argv.slice(2);
    const concurrency = parseInt(parseFlag(args, "concurrency", "c") || "10");
    const outArg = parseFlag(args, "out", "o");
    if (!Number.isFinite(concurrency) || concurrency < 1 || concurrency > 50) {
        console.log("--concurrency 必须 1-50"); process.exit(1);
    }

    const password = await askPassword("请输入解密密码: ");
    let wallets;
    try { wallets = loadWallets(__dirname, password); }
    catch (e) { console.log("解密失败:", e.message); process.exit(1); }

    const selected = parseSelectors(args, wallets.length);
    if (selected) wallets = selected.map(i => ({ ...wallets[i - 1], _origIdx: i }));
    else wallets = wallets.map((w, i) => ({ ...w, _origIdx: i + 1 }));

    const outFile = outArg || join(__dirname, `report-${fmtTs()}.csv`);

    console.log(`=== 钱包资金汇总报告 ===`);
    console.log(`钱包: ${wallets.length}${selected ? ` (${selected.slice(0, 20).join(",")}${selected.length > 20 ? "..." : ""})` : " (全部)"} | 并发: ${concurrency}`);
    console.log(`输出: ${outFile}\n`);

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
                    const el = ((Date.now() - t0) / 1000).toFixed(0);
                    console.log(`[${ts()}] 进度 ${done}/${wallets.length} (${el}s)`);
                }
            }
        })());
    }
    await Promise.all(workers);

    // 写 CSV (合并模式: outFile 已存在 → 按 idx 去重, 新数据覆盖旧)
    const all = results.filter(Boolean).sort((a, b) => a.idx - b.idx);
    const header = [
        "idx","address","eth","usdt",
        "funding_total","withdrawable","initialMargin","pnl","fees","openPositions",
        "rank","totalPoints","lastPeriodPoints","totalQuestPoints","pendingQuestPoints",
        "error",
    ];
    const csvEscape = v => {
        const s = String(v ?? "");
        return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const renderRow = r => header.map(k => csvEscape(r[k])).join(",");

    // 旧行: idx → 原始行字符串 (保留 header 一致时的历史数据)
    const existing = new Map();
    let mergedCount = 0;
    if (fs.existsSync(outFile)) {
        const lines = fs.readFileSync(outFile, "utf8").split(/\r?\n/).filter(s => s.length);
        if (lines.length > 0) {
            const oldHeader = lines[0].split(",");
            const headerMatch = oldHeader.length === header.length && oldHeader.every((h, i) => h === header[i]);
            if (!headerMatch) {
                const bak = outFile + ".bak-" + fmtTs();
                fs.renameSync(outFile, bak);
                console.log(`!! 旧文件 header 不匹配, 备份到 ${bak}, 写新文件`);
            } else {
                for (let i = 1; i < lines.length; i++) {
                    const idx = parseInt(lines[i].split(",")[0]);   // idx 是纯整数, 不会被 quote
                    if (Number.isFinite(idx)) existing.set(idx, lines[i]);
                }
                mergedCount = existing.size;
                console.log(`已存在 ${outFile}: ${mergedCount} 行, append/merge (新 idx 覆盖旧)`);
            }
        }
    }
    for (const r of all) existing.set(r.idx, renderRow(r));   // 新覆盖旧
    const finalRows = [...existing.entries()].sort((a, b) => a[0] - b[0]).map(([, line]) => line);
    fs.writeFileSync(outFile, [header.join(","), ...finalRows].join("\n") + "\n");
    if (mergedCount > 0) {
        console.log(`合并完成: 旧 ${mergedCount} + 新 ${all.length} → 文件共 ${finalRows.length} 行 (按 idx 去重)`);
    }

    // 汇总
    const sum = k => all.reduce((s, r) => {
        const v = parseFloat(r[k]);
        return Number.isFinite(v) ? s + v : s;
    }, 0);
    const totalEth = sum("eth");
    const totalUsdt = sum("usdt");
    const totalFunding = sum("funding_total");
    const totalPnl = sum("pnl");
    const totalFees = sum("fees");
    const totalIM = sum("initialMargin");
    const totalOpenPos = all.reduce((s, r) => s + (parseInt(r.openPositions) || 0), 0);
    const failed = all.filter(r => r.error);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);

    const totalPoints = sum("totalPoints");
    const totalQuestP = sum("totalQuestPoints");
    const pendingQuestP = sum("pendingQuestPoints");
    const lastPeriodP = sum("lastPeriodPoints");

    console.log(`\n${"=".repeat(70)}`);
    console.log(`=== 汇总 (${elapsed}s) ===`);
    console.log(`钱包总数:               ${all.length}`);
    console.log(`链上 ETH 总和:          ${totalEth.toFixed(6)}`);
    console.log(`链上 USDT 总和:         ${totalUsdt.toFixed(6)}`);
    console.log(`funding 总和:           ${totalFunding.toFixed(4)} USDT`);
    console.log(`withdrawable 总和:      ${sum("withdrawable").toFixed(4)} USDT`);
    console.log(`initialMargin 总和:     ${totalIM.toFixed(4)} USDT`);
    console.log(`总 PnL:                 ${totalPnl.toFixed(4)} USDT`);
    console.log(`总 fees:                ${totalFees.toFixed(4)} USDT`);
    console.log(`未平仓位数:             ${totalOpenPos}`);
    console.log("");
    console.log(`总 totalPoints:         ${totalPoints.toFixed(2)}  (leaderboard 累计)`);
    console.log(`总 lastPeriodPoints:    ${lastPeriodP.toFixed(2)}  (上周期入账)`);
    console.log(`总 totalQuestPoints:    ${totalQuestP.toFixed(2)}  (历史已结算 quest)`);
    console.log(`总 pendingQuestPoints:  ${pendingQuestP.toFixed(2)}  (本周期待结算)`);
    console.log("");
    console.log(`查询失败钱包:           ${failed.length}`);
    console.log(`\nCSV → ${outFile}`);

    if (failed.length > 0) {
        console.log(`\n失败钱包重跑: node report.mjs ${failed.map(f => f.idx).join(" ")}`);
    }
}

main().then(() => process.exit(0), e => { console.error("fatal:", e); process.exit(1); });
