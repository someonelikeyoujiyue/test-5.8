// 资金汇总报告: 每钱包链上 ETH/USDT + Rho funding 账户 (total/withdrawable/IM/pnl/fees), 输出 CSV
//
// 用法:
//   node report.mjs                       全部钱包
//   node report.mjs 1-100                 钱包 1-100
//   node report.mjs --c=15                并发 (默认 10)
//   node report.mjs --out=report.csv      指定输出文件 (默认 report-YYYYMMDD-HHMMSS.csv)
//
// CSV 列: idx,address,eth,usdt,funding_total,withdrawable,initialMargin,pnl,fees,openPositions,error

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

function makeAxios(walletProxy) {
    const cfg = { baseURL: config.apiBase, timeout: 30000 };
    if (config.useProxy && walletProxy) {
        const auth = walletProxy.username
            ? `${encodeURIComponent(walletProxy.username)}:${encodeURIComponent(walletProxy.password)}@`
            : "";
        const a = new HttpsProxyAgent(`http://${auth}${walletProxy.host}:${walletProxy.port}`);
        cfg.httpAgent = a; cfg.httpsAgent = a;
    }
    return axios.create(cfg);
}

async function rhoLogin(http, w) {
    const wallet = new Wallet(w.privateKey);
    const n = await http.post("/auth-api/v1/nonce", { address: wallet.address });
    const sig = await wallet.signMessage(n.data.messageToSign);
    const l = await http.post("/auth-api/v1/login", { address: wallet.address, signature: sig, type: "evm" });
    if (!l.data.token) throw new Error("login 无 token");
    return { headers: { Authorization: `Bearer ${l.data.token}` } };
}

async function queryOnchain(w) {
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const rpcProxy = (config.deposit.rpcUseProxy ?? false) ? w.proxy : null;
            const provider = buildProvider(config.deposit.ethRpcUrls ?? config.deposit.ethRpcUrl, rpcProxy, w.address);
            const usdt = new Contract(config.deposit.usdt, ERC20_ABI, provider);
            const [eth, ub, decimals] = await Promise.all([
                provider.getBalance(w.address),
                usdt.balanceOf(w.address),
                usdt.decimals(),
            ]);
            return { eth: formatEther(eth), usdt: formatUnits(ub, decimals) };
        } catch (e) {
            lastErr = e;
            if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 1000));
        }
    }
    throw lastErr;
}

async function queryRho(w) {
    const http = makeAxios(w.proxy);
    const auth = await rhoLogin(http, w);
    const [ma, pos] = await Promise.all([
        http.get("/api/v1/margin-accounts", { headers: auth.headers }),
        http.get("/api/v1/users/positions", { headers: auth.headers }),
    ]);
    const fa = ma.data.userMarginAccounts?.find(a => a.marginAccount === "funding");
    const positions = pos.data.positions ?? [];
    const open = positions.filter(p => parseFloat(p.notional) !== 0);
    return {
        funding_total: fa?.totalMargin ?? "0",
        withdrawable: fa?.withdrawableBalance ?? "0",
        initialMargin: fa?.initialMarginRequirement ?? "0",
        pnl: fa?.totalPnl ?? "0",
        fees: fa?.tradingFees ?? "0",
        openPositions: open.length,
    };
}

async function processWallet(w, idx) {
    const tag = `[${String(idx).padStart(4)}] ${w.address.slice(0, 10)}`;
    let onchain = { eth: "?", usdt: "?" };
    let rho = { funding_total: "?", withdrawable: "?", initialMargin: "?", pnl: "?", fees: "?", openPositions: "?" };
    const errs = [];

    const [onR, rhR] = await Promise.allSettled([queryOnchain(w), queryRho(w)]);
    if (onR.status === "fulfilled") onchain = onR.value;
    else errs.push(`onchain: ${errMsg(onR.reason).slice(0, 80)}`);
    if (rhR.status === "fulfilled") rho = rhR.value;
    else errs.push(`rho: ${errMsg(rhR.reason).slice(0, 80)}`);

    const error = errs.join(" | ");
    console.log(`[${ts()}] ${tag}  ETH=${onchain.eth}  USDT=${onchain.usdt}  funding=${rho.funding_total}  pnl=${rho.pnl}  fees=${rho.fees}  pos=${rho.openPositions}${error ? "  ✗ " + error : ""}`);
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

    // 写 CSV
    const all = results.filter(Boolean).sort((a, b) => a.idx - b.idx);
    const header = ["idx","address","eth","usdt","funding_total","withdrawable","initialMargin","pnl","fees","openPositions","error"];
    const csv = [header.join(",")];
    for (const r of all) {
        const row = header.map(k => {
            const v = r[k] ?? "";
            const s = String(v);
            return s.includes(",") || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
        });
        csv.push(row.join(","));
    }
    fs.writeFileSync(outFile, csv.join("\n") + "\n");

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

    console.log(`\n${"=".repeat(70)}`);
    console.log(`=== 汇总 (${elapsed}s) ===`);
    console.log(`钱包总数:           ${all.length}`);
    console.log(`链上 ETH 总和:      ${totalEth.toFixed(6)}`);
    console.log(`链上 USDT 总和:     ${totalUsdt.toFixed(6)}`);
    console.log(`funding 总和:       ${totalFunding.toFixed(4)} USDT`);
    console.log(`withdrawable 总和:  ${sum("withdrawable").toFixed(4)} USDT`);
    console.log(`initialMargin 总和: ${totalIM.toFixed(4)} USDT`);
    console.log(`总 PnL:             ${totalPnl.toFixed(4)} USDT`);
    console.log(`总 fees:            ${totalFees.toFixed(4)} USDT`);
    console.log(`未平仓位数:         ${totalOpenPos}`);
    console.log(`查询失败钱包:        ${failed.length}`);
    console.log(`\nCSV → ${outFile}`);

    if (failed.length > 0) {
        console.log(`\n失败钱包重跑: node report.mjs ${failed.map(f => f.idx).join(" ")}`);
    }
}

main().then(() => process.exit(0), e => { console.error("fatal:", e); process.exit(1); });
