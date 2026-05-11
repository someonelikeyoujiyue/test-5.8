// Rho-X funding 账户提现 (USDT)
//
// 流程 (反编译 x.rho.trading 前端 + brute-force 验签后确认):
//   1) 登录 RhoClient 拿 Bearer token
//   2) GET /api/v1/users/balances/withdrawable?marginAccount=funding
//        → withdrawableBalance / fee / maxNetWithdrawAmount / nextWithdrawSequenceId
//   3) 签 EIP-191 personal_sign:
//        hash = keccak256(abi.encode(
//            bytes32  depositaryId,        // 0xf004fc6e... (exchange-info)
//            uint256  withdrawalId,        // = nextWithdrawSequenceId
//            address  receiver,            // 钱包自己
//            uint256  amount,              // 净额 × 10^6 (USDT 6 dec)
//            address  asset,               // USDT 合约
//            bool     unwrapNativeToken,   // false
//            string   metadata,            // JSON.stringify([marginAccount]) = '["funding"]'
//            uint64   deadline             // now + 5 days
//        ))
//        ownerSignature = wallet.signMessage({ raw: hash })
//   4) POST /api/v1/users/withdrawals { amount, currencyId, marginAccount, chainId,
//                                       clientWithdrawalId, deadline, unwrapNativeToken, ownerSignature }
//        → 202 Accepted (空 body), 异步等 Rho keeper 上链
//   5) 状态: GET /api/v1/users/transfers → 找 transferType=withdrawal, transferStatus pending→confirmed
//
// 用法:
//   node withdraw.mjs                       全部钱包, 默认并发 5
//   node withdraw.mjs 1-100                 钱包 1-100
//   node withdraw.mjs 1 4 8                 指定钱包
//   node withdraw.mjs --c=10                并发
//   node withdraw.mjs --dry-run             只构造 + 打印, 不真提交
//   node withdraw.mjs --min=5               funding maxNet < 5 USDT 跳过
//   node withdraw.mjs --yes                 跳过确认
//
// 安全:
//   - dryRun 时不发 POST, 不签名也能跑通逻辑 (打印将要构造的 hash)
//   - 任何 wallet maxNetWithdrawAmount=0 自动跳过 (fee=1 比余额还大)
//   - 失败钱包末尾列出可重跑命令

import { fileURLToPath } from "url";
import { dirname } from "path";
import readline from "readline";
import { Wallet, AbiCoder, keccak256, getBytes, parseUnits } from "ethers";
import axios from "axios";
import { randomUUID } from "crypto";
import { HttpsProxyAgent } from "https-proxy-agent";
import { askPassword, loadWallets } from "./lib/cipher.mjs";
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

const SIGN_TYPES = ["bytes32", "uint256", "address", "uint256", "address", "bool", "string", "uint64"];
const CHAIN_ID = "evm:1";
const MARGIN_ACCOUNT = "funding";
const CURRENCY = "USDT";
const USDT_DECIMALS = 6;
const DEADLINE_OFFSET_SECONDS = 3600 * 24 * 5;   // 5 天

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
    const l = await http.post("/auth-api/v1/login", {
        address: wallet.address, signature: sig, type: "evm",
    });
    const token = l.data.token;
    if (!token) throw new Error(`login 无 token: ${JSON.stringify(l.data).slice(0, 100)}`);
    return { token, headers: { Authorization: `Bearer ${token}` } };
}

async function fetchDepositaryId(http) {
    const ei = (await http.get("/api/v1/exchange-info")).data;
    const dep = ei.depositaries?.find(d => d.blockchainId === CHAIN_ID);
    if (!dep) throw new Error(`exchange-info 没找到 ${CHAIN_ID} depositary`);
    return dep.depositaryId;
}

async function fetchWithdrawable(http, headers) {
    const { data } = await http.get(`/api/v1/users/balances/withdrawable?marginAccount=${MARGIN_ACCOUNT}`, { headers });
    const usdt = data.withdrawables?.find(w => w.currency === CURRENCY);
    if (!usdt) return null;
    return {
        withdrawableBalance: usdt.withdrawableBalance,
        fee: usdt.fee,
        maxNetWithdrawAmount: usdt.maxNetWithdrawAmount,
        nextWithdrawSequenceId: data.nextWithdrawSequenceId,
    };
}

const coder = AbiCoder.defaultAbiCoder();

// 构造 EIP-191 personal_sign 的 hash
function buildWithdrawHash({ depositaryId, withdrawalId, receiver, amountRaw, asset, deadline, marginAccount }) {
    const metadata = JSON.stringify([marginAccount]);
    const enc = coder.encode(SIGN_TYPES, [
        depositaryId,
        BigInt(withdrawalId),
        receiver,
        amountRaw,
        asset,
        false,
        metadata,
        BigInt(deadline),
    ]);
    return { hash: keccak256(enc), metadata };
}

async function processWallet(w, idx, opts) {
    const { dryRun, minAmount } = opts;
    const tag = `[${String(idx).padStart(4)}] ${w.address.slice(0, 10)}`;
    const log = m => console.log(`[${ts()}] ${tag} ${m}`);

    const wallet = new Wallet(w.privateKey);
    const http = makeAxios(w.proxy);

    let auth;
    try {
        auth = await rhoLogin(http, w);
    } catch (e) {
        log(`login 失败: ${errMsg(e)}`);
        return { idx, address: w.address, ok: false, error: `login: ${errMsg(e)}` };
    }

    let withdrawable;
    try {
        withdrawable = await fetchWithdrawable(http, auth.headers);
    } catch (e) {
        log(`查 withdrawable 失败: ${errMsg(e)}`);
        return { idx, address: w.address, ok: false, error: `withdrawable: ${errMsg(e)}` };
    }
    if (!withdrawable) {
        log(`无 USDT 可提`);
        return { idx, address: w.address, ok: true, skipped: "no-usdt-balance" };
    }
    const maxNet = parseFloat(withdrawable.maxNetWithdrawAmount);
    if (!Number.isFinite(maxNet) || maxNet <= 0) {
        log(`maxNetWithdrawAmount=${withdrawable.maxNetWithdrawAmount} ≤ 0, 跳过`);
        return { idx, address: w.address, ok: true, skipped: "max-net-zero" };
    }
    if (maxNet < minAmount) {
        log(`maxNet=${maxNet} < min ${minAmount}, 跳过`);
        return { idx, address: w.address, ok: true, skipped: `below-min-${minAmount}` };
    }

    const depositaryId = await fetchDepositaryId(http);

    // 用 maxNetWithdrawAmount 全提
    const amountStr = withdrawable.maxNetWithdrawAmount;
    const amountRaw = parseUnits(amountStr, USDT_DECIMALS);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + DEADLINE_OFFSET_SECONDS);
    const clientWithdrawalId = randomUUID();

    const { hash, metadata } = buildWithdrawHash({
        depositaryId,
        withdrawalId: withdrawable.nextWithdrawSequenceId,
        receiver: wallet.address,
        amountRaw,
        asset: config.deposit.usdt,
        deadline,
        marginAccount: MARGIN_ACCOUNT,
    });

    log(`maxNet=${amountStr} fee=${withdrawable.fee} seqId=${withdrawable.nextWithdrawSequenceId} hash=${hash.slice(0, 16)}...`);

    if (dryRun) {
        log(`[DRY] amountRaw=${amountRaw} metadata=${metadata} deadline=${deadline}`);
        return { idx, address: w.address, ok: true, dry: true, amount: amountStr };
    }

    const ownerSignature = await wallet.signMessage(getBytes(hash));
    const body = {
        amount: amountStr,
        currencyId: CURRENCY,
        marginAccount: MARGIN_ACCOUNT,
        chainId: CHAIN_ID,
        clientWithdrawalId,
        deadline: deadline.toString(),
        unwrapNativeToken: false,
        ownerSignature,
    };

    try {
        const r = await http.post("/api/v1/users/withdrawals", body, { headers: auth.headers });
        log(`✓ POST status=${r.status} amount=${amountStr} clientWithdrawalId=${clientWithdrawalId}`);
        return { idx, address: w.address, ok: true, amount: amountStr, clientWithdrawalId };
    } catch (e) {
        log(`✗ POST 失败: ${errMsg(e)}`);
        return { idx, address: w.address, ok: false, error: `withdraw POST: ${errMsg(e)}`, sentBody: body };
    }
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
    for (const a of args) {
        for (const n of names) {
            const m = a.match(new RegExp(`^--${n}=(.+)$`));
            if (m) return m[1];
        }
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
    const concurrency = parseInt(parseFlag(args, "concurrency", "c") || "5");
    const minAmount = parseFloat(parseFlag(args, "min") || "0");
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

    console.log(`=== Rho funding 提现 ${dryRun ? "(DRY-RUN)" : "实盘"} ===`);
    console.log(`钱包: ${wallets.length}${selected ? ` (${selected.slice(0, 20).join(",")}${selected.length > 20 ? "..." : ""})` : " (全部)"} | 并发: ${concurrency}`);
    if (minAmount > 0) console.log(`跳过 maxNet < ${minAmount} USDT 的钱包`);
    console.log(`手续费固定 1 USDT/笔, 全提 maxNetWithdrawAmount\n`);

    if (!dryRun && !skipConfirm) {
        const ok = await confirm(`将对 ${wallets.length} 钱包发起提现, 确认? (yes/no) `);
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
                const r = await processWallet(w, w._origIdx, { dryRun, minAmount });
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
    const submitted = ok.filter(r => !r.skipped && !r.dry);
    const skipped = ok.filter(r => r.skipped);
    const dry = ok.filter(r => r.dry);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    const totalAmount = submitted.reduce((s, r) => s + parseFloat(r.amount || 0), 0);

    console.log(`\n${"=".repeat(60)}`);
    console.log(`=== 完成 (${elapsed}s) ===`);
    console.log(`钱包总数:     ${all.length}`);
    console.log(`成功提交:     ${submitted.length}  净提现总额 ${totalAmount.toFixed(2)} USDT`);
    if (dry.length)     console.log(`DRY 通过:     ${dry.length}`);
    if (skipped.length) console.log(`跳过:         ${skipped.length}`);
    if (failed.length)  console.log(`失败:         ${failed.length}`);

    if (failed.length > 0) {
        console.log(`\n失败钱包重跑: node withdraw.mjs ${failed.map(f => f.idx).join(" ")}`);
        console.log(`\n失败明细:`);
        for (const f of failed.sort((a, b) => a.idx - b.idx)) {
            console.log(`  [${String(f.idx).padStart(4)}] ${f.address}  ${f.error}`);
        }
    }
}

main().then(() => process.exit(0), e => { console.error("fatal:", e); process.exit(1); });
