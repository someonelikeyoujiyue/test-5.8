// 钱包状态检查: 链上余额 + Rho 协议侧 funding 账户 + 最近 transfer 状态
//
// 用法 (跟 deposit.mjs 一样的选择器):
//   node verify.mjs 1
//   node verify.mjs 1-3
//   node verify.mjs "10 17"
//   node verify.mjs        (= 全部, 慎用)
//
// Flag:
//   --onchain   只查链上 (ETH/USDT/allowance/nonce), 跳过 Rho 登录, 快
//   --rho       只查 Rho 协议侧 (funding/持仓/transfers), 跳过链上, 跑得也快
//   (默认)      两者都查 (慢, 适合详细诊断)
//   --c=N       并发 (默认 10)

import { fileURLToPath } from "url";
import { dirname } from "path";
import { Wallet, Contract, formatUnits, formatEther } from "ethers";
import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";
import { askPassword, loadWallets } from "./lib/cipher.mjs";
import { buildProvider } from "./lib/rpc.mjs";
import { config } from "./config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const ts = () => new Date().toISOString().slice(11, 19);
const errMsg = e => e?.response ? `${e.response.status} ${JSON.stringify(e.response.data).slice(0, 200)}` : e?.message;

const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function decimals() view returns (uint8)",
];

function parseSelectors(args, max) {
    const tokens = args.flatMap(a => String(a).split(/\s+/)).filter(Boolean);
    if (!tokens.length) return null;
    const set = new Set();
    for (const t of tokens) {
        const m = t.match(/^(\d+)(?:-(\d+))?$/);
        if (!m) { console.log(`无法识别 "${t}"`); process.exit(1); }
        const a = parseInt(m[1]);
        const b = m[2] ? parseInt(m[2]) : a;
        if (a < 1 || b < a || a > max) { console.log(`范围 ${t} 无效, 共 ${max} 个钱包`); process.exit(1); }
        for (let i = a; i <= Math.min(b, max); i++) set.add(i);
    }
    return [...set].sort((x, y) => x - y);
}

function makeAxios(walletProxy) {
    const cfg = { baseURL: config.apiBase, timeout: 20000 };
    if (walletProxy) {
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
    const l = await http.post("/auth-api/v1/login", {
        address: wallet.address, signature: sig, type: "evm",
    });
    const H = { headers: { Authorization: `Bearer ${l.data.token}` } };
    // 激活索引器 (前端登录后必调) - 否则 deposit 不会被 promote 到 user 账户
    try { await http.get("/api/v1/users/account", H); } catch {}
    return H;
}

async function checkWallet(w, idx, mode = "all") {
    const tag = `[${idx}] ${w.address.slice(0, 10)}...${w.address.slice(-4)}`;
    console.log(`\n${"=".repeat(70)}\n${tag} (proxy=${w.proxy?.host || "none"})`);

    // ---- 链上 (mode=all|onchain) ----
    let onchain = null;
    if (mode === "all" || mode === "onchain") {
        onchain = { eth: "?", usdt: "?", allowance: "?", nonce: "?" };
        try {
            const rpcProxy = (config.deposit.rpcUseProxy ?? false) ? w.proxy : null;
            const provider = buildProvider(config.deposit.ethRpcUrls ?? config.deposit.ethRpcUrl, rpcProxy, w.address);
            const usdt = new Contract(config.deposit.usdt, ERC20_ABI, provider);
            const [eth, ub, alw, nonce, decimals] = await Promise.all([
                provider.getBalance(w.address),
                usdt.balanceOf(w.address),
                usdt.allowance(w.address, config.deposit.gateway),
                provider.getTransactionCount(w.address),
                usdt.decimals(),
            ]);
            onchain = {
                eth: formatEther(eth),
                usdt: formatUnits(ub, decimals),
                allowance: alw >= 2n ** 200n ? "MAX" : formatUnits(alw, decimals),
                nonce,
            };
        } catch (e) {
            console.log(`  链上查询失败: ${errMsg(e)}`);
        }
        console.log(`  链上: ETH=${onchain.eth} USDT=${onchain.usdt} allowance=${onchain.allowance} nonce=${onchain.nonce}`);
    }

    // mode=onchain 时不查 Rho, 早返回
    if (mode === "onchain") {
        return { address: w.address, onchain };
    }

    // ---- Rho 协议侧 (mode=all|rho) ----
    try {
        const http = makeAxios(w.proxy);
        const H = await rhoLogin(http, w);

        // margin-accounts 拿 funding 账户余额
        const ma = (await http.get("/api/v1/margin-accounts", H)).data;
        const fa = ma.userMarginAccounts?.find(a => a.marginAccount === "funding");
        if (fa) {
            console.log(`  funding: total=${fa.totalMargin} withdrawable=${fa.withdrawableBalance} IM=${fa.initialMarginRequirement} pnl=${fa.totalPnl} fees=${fa.tradingFees}`);
        }

        // 持仓
        const pos = (await http.get("/api/v1/users/positions", H)).data.positions ?? [];
        const open = pos.filter(p => parseFloat(p.notional) !== 0);
        if (open.length) {
            console.log(`  持仓: ${open.length} 笔 (未平!)`);
            for (const p of open) console.log(`    ${p.symbol} dir=${p.riskDirection} notional=${p.notional} avgPx=${p.avgPrice}`);
        } else {
            console.log(`  持仓: 0`);
        }

        // 最近 transfers
        const tr = (await http.get("/api/v1/users/transfers", H)).data.updates ?? [];
        const recent = tr.slice(0, 5);
        if (recent.length) {
            console.log(`  最近 ${recent.length} 笔 transfer:`);
            for (const t of recent) {
                const flag = t.transferStatus === "pending" ? "⏳" : (t.transferStatus === "completed" || t.transferStatus === "settled") ? "✓" : "?";
                console.log(`    ${flag} ${t.transferType.padEnd(10)} ${t.delta} ${t.currencyId} → ${t.marginAccount}  status=${t.transferStatus}  tx=${t.chainTxHash?.slice(0, 14) ?? "(api)"}  ${t.time?.slice(0, 19)}`);
            }
        } else {
            console.log(`  transfers: 无记录`);
        }

        const fundingTotal = fa ? parseFloat(fa.totalMargin) : 0;
        const pendingCount = tr.filter(t => t.transferStatus === "pending").length;
        // 有 deposit 转账历史 (任何 status) 但 funding 仍为 0 + 没 pending = 疑似丢失
        const hasDepositHistory = tr.some(t => t.transferType === "deposit");
        const lostCandidate = fundingTotal === 0 && pendingCount === 0 && hasDepositHistory;

        return {
            address: w.address,
            onchain,
            funding: fa ? { total: fa.totalMargin, withdrawable: fa.withdrawableBalance, pnl: fa.totalPnl } : null,
            openPositions: open.length,
            pendingTransfers: pendingCount,
            transferCount: tr.length,
            hasDepositHistory,
            lostCandidate,
            fundingZero: fundingTotal === 0,
        };
    } catch (e) {
        console.log(`  Rho API 查询失败: ${errMsg(e)}`);
        return { address: w.address, onchain, error: errMsg(e) };
    }
}

// CLI flag: --concurrency=N (默认 10)
function parseConcurrency(args) {
    for (const a of args) {
        const m = a.match(/^--(?:concurrency|c)=(\d+)$/);
        if (m) {
            const n = parseInt(m[1]);
            if (n > 0 && n <= 200) return n;
        }
    }
    return 10;
}

async function main() {
    const password = await askPassword("请输入解密密码: ");
    let wallets;
    try { wallets = loadWallets(__dirname, password); }
    catch (e) { console.log("解密失败:", e.message); process.exit(1); }

    const cliArgs = process.argv.slice(2);
    const concurrency = parseConcurrency(cliArgs);
    // mode: --onchain | --rho (互斥), 默认 all
    const onchainOnly = cliArgs.includes("--onchain");
    const rhoOnly = cliArgs.includes("--rho");
    if (onchainOnly && rhoOnly) { console.log("--onchain 和 --rho 互斥"); process.exit(1); }
    const mode = onchainOnly ? "onchain" : rhoOnly ? "rho" : "all";

    // selector 解析时跳过 -- flag
    const selectorTokens = cliArgs.filter(a => !a.startsWith("--"));
    const selected = parseSelectors(selectorTokens, wallets.length);
    if (selected) {
        wallets = selected.map(i => ({ ...wallets[i - 1], _origIdx: i }));
    } else {
        wallets = wallets.map((w, i) => ({ ...w, _origIdx: i + 1 }));
    }

    console.log(`=== 钱包状态检查 (mode=${mode}) ===`);
    console.log(`选中: ${wallets.length} 个钱包${selected ? ` (${selected.join(",")})` : " (全部)"} | 并发: ${concurrency}`);
    if (mode !== "rho") console.log(`gateway: ${config.deposit.gateway}`);
    if (mode !== "onchain") console.log(`apiBase: ${config.apiBase}`);

    let totalFunding = 0;
    let totalEth = 0;
    let totalUsdt = 0;
    let totalPending = 0;
    let totalOpenPos = 0;
    let done = 0;
    const total = wallets.length;
    const results = new Array(wallets.length);

    // 并发池: N 个 worker 共享 queue
    const queue = wallets.map((w, i) => ({ ...w, _slot: i }));
    const workers = [];
    for (let i = 0; i < Math.min(concurrency, queue.length); i++) {
        workers.push((async () => {
            while (queue.length) {
                const w = queue.shift();
                if (!w) break;
                const r = await checkWallet(w, w._origIdx, mode);
                results[w._slot] = { idx: w._origIdx, ...r };
                if (r.funding?.total) totalFunding += parseFloat(r.funding.total);
                if (r.onchain?.eth) totalEth += parseFloat(r.onchain.eth);
                if (r.onchain?.usdt) totalUsdt += parseFloat(r.onchain.usdt);
                totalPending += r.pendingTransfers || 0;
                totalOpenPos += r.openPositions || 0;
                done++;
                if (total > 50 && done % 50 === 0) {
                    console.log(`\n[进度] ${done}/${total}\n`);
                }
            }
        })());
    }
    await Promise.all(workers);

    if (wallets.length > 1) {
        // 分类 (rho 块跳过时 lost/funded/pending 不可用)
        const lostList = results.filter(r => r?.lostCandidate);
        const fundedList = results.filter(r => r && !r.fundingZero);
        const pendingList = results.filter(r => r?.pendingTransfers > 0);
        const freshList = results.filter(r => r?.fundingZero && r.pendingTransfers === 0 && !r.hasDepositHistory && !r.error);
        const errorList = results.filter(r => r?.error);

        // onchain 分类: 哪些钱包没 ETH/USDT (0 余额); allowance 是否 MAX (deposit 准备状态)
        const noEthList   = mode !== "rho" ? results.filter(r => r?.onchain && parseFloat(r.onchain.eth || 0) === 0) : [];
        const noUsdtList  = mode !== "rho" ? results.filter(r => r?.onchain && parseFloat(r.onchain.usdt || 0) === 0) : [];
        const noApproveList = mode !== "rho" ? results.filter(r => r?.onchain && r.onchain.allowance !== "MAX") : [];

        console.log(`\n${"=".repeat(70)}\n汇总 (mode=${mode}):`);
        console.log(`  钱包数:                ${wallets.length}`);
        if (mode !== "rho") {
            console.log(`  链上 ETH 总和:         ${totalEth.toFixed(6)}`);
            console.log(`  链上 USDT 总和:        ${totalUsdt.toFixed(6)}`);
            console.log("");
            console.log(`  ⚠️  无 ETH (=0):         ${noEthList.length}`);
            console.log(`  ⚠️  无 USDT (=0):        ${noUsdtList.length}`);
            console.log(`  ⚠️  allowance ≠ MAX:    ${noApproveList.length}  (deposit 前需 approve)`);
        }
        if (mode !== "onchain") {
            console.log(`  funding 账户总和:      ${totalFunding.toFixed(6)} USDT`);
            console.log(`  pending transfers 总:  ${totalPending}`);
            console.log(`  未平仓位:              ${totalOpenPos}`);
            console.log("");
            console.log(`  ✓ 有 funding 余额:     ${fundedList.length}`);
            console.log(`  ⏳ 有 pending:          ${pendingList.length}`);
            console.log(`  🆕 新钱包 (无历史):     ${freshList.length}`);
            console.log(`  ⚠️  疑似丢失:            ${lostList.length}  (有 deposit 历史 + 无 pending + funding=0)`);
        }
        console.log(`  ✗ 查询失败:            ${errorList.length}`);

        if (lostList.length > 0) {
            console.log(`\n${"=".repeat(70)}`);
            console.log(`⚠️  疑似丢失明细 (这些钱包链上 deposit 过但协议侧没 credit):`);
            console.log("idx    address                                       transfers  funding");
            for (const r of lostList) {
                console.log(`  [${String(r.idx).padStart(3)}]  ${r.address}  ${String(r.transferCount).padStart(2)} 笔     ${r.funding?.total ?? "0"}`);
            }
            console.log(`\n建议: 把这些 address 拿去找 Rho 客服 (Discord https://discord.gg/pmCMcQV35r) 申请 reconcile`);
        }

        // onchain 资金问题明细 (truncate 到 30 个; 超出只打 idx 列表)
        function printOnchainList(label, list, valueKey, unit) {
            if (list.length === 0) return;
            console.log(`\n${label} (${list.length} 个):`);
            const show = list.slice(0, 30);
            for (const r of show) {
                console.log(`  [${String(r.idx).padStart(4)}] ${r.address}  ${valueKey}=${r.onchain?.[valueKey]} ${unit}`);
            }
            if (list.length > 30) console.log(`  ... 还有 ${list.length - 30} 个, idx: ${list.slice(30).map(r => r.idx).join(",")}`);
        }
        printOnchainList(`🔴 无 ETH 钱包`, noEthList, "eth", "ETH");
        printOnchainList(`🔴 无 USDT 钱包`, noUsdtList, "usdt", "USDT");

        if (errorList.length > 0) {
            console.log(`\n查询失败钱包 (idx): ${errorList.map(r => r.idx).join(",")}`);
        }
    }
}

main().catch(e => { console.error("fatal:", e); process.exit(1); });
