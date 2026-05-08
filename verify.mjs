// 钱包状态检查: 链上余额 + Rho 协议侧 funding 账户 + 最近 transfer 状态
//
// 用法 (跟 deposit.mjs 一样的选择器):
//   node verify.mjs 1
//   node verify.mjs 1-3
//   node verify.mjs "10 17"
//   node verify.mjs        (= 全部, 慎用)

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

async function checkWallet(w, idx) {
    const tag = `[${idx}] ${w.address.slice(0, 10)}...${w.address.slice(-4)}`;
    console.log(`\n${"=".repeat(70)}\n${tag} (proxy=${w.proxy?.host || "none"})`);

    // ---- 链上 ----
    let onchain = { eth: "?", usdt: "?", allowance: "?", nonce: "?" };
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

    // ---- Rho 协议侧 ----
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

        return {
            onchain,
            funding: fa ? { total: fa.totalMargin, withdrawable: fa.withdrawableBalance, pnl: fa.totalPnl } : null,
            openPositions: open.length,
            pendingTransfers: tr.filter(t => t.transferStatus === "pending").length,
        };
    } catch (e) {
        console.log(`  Rho API 查询失败: ${errMsg(e)}`);
        return { onchain, error: errMsg(e) };
    }
}

async function main() {
    const password = await askPassword("请输入解密密码: ");
    let wallets;
    try { wallets = loadWallets(__dirname, password); }
    catch (e) { console.log("解密失败:", e.message); process.exit(1); }

    const selected = parseSelectors(process.argv.slice(2), wallets.length);
    if (selected) {
        wallets = selected.map(i => ({ ...wallets[i - 1], _origIdx: i }));
    } else {
        wallets = wallets.map((w, i) => ({ ...w, _origIdx: i + 1 }));
    }

    console.log(`=== 钱包状态检查 ===`);
    console.log(`选中: ${wallets.length} 个钱包${selected ? ` (${selected.join(",")})` : " (全部)"}`);
    console.log(`gateway: ${config.deposit.gateway}`);
    console.log(`apiBase: ${config.apiBase}`);

    let totalFunding = 0;
    let totalEth = 0;
    let totalPending = 0;
    let totalOpenPos = 0;

    for (const w of wallets) {
        const r = await checkWallet(w, w._origIdx);
        if (r.funding?.total) totalFunding += parseFloat(r.funding.total);
        if (r.onchain?.eth) totalEth += parseFloat(r.onchain.eth);
        totalPending += r.pendingTransfers || 0;
        totalOpenPos += r.openPositions || 0;
    }

    if (wallets.length > 1) {
        console.log(`\n${"=".repeat(70)}\n汇总:`);
        console.log(`  钱包数: ${wallets.length}`);
        console.log(`  链上 ETH 总和: ${totalEth.toFixed(6)}`);
        console.log(`  funding 账户总和: ${totalFunding.toFixed(6)} USDT`);
        console.log(`  pending transfers: ${totalPending}`);
        console.log(`  未平仓位: ${totalOpenPos}`);
    }
}

main().catch(e => { console.error("fatal:", e); process.exit(1); });
