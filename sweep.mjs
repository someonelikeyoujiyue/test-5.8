// 回充: 把每个钱包的 USDT + ETH 转回 wallets.csv 的 withDrawAddress 列
//
// 顺序: 先 USDT 后 ETH (USDT transfer 要烧 ETH 当 gas, ETH 先扫就没 gas 转 USDT 了)
//   Phase 1: USDT.transfer(withDrawAddress, balance)         ~60k gas
//   Phase 2: sendTransaction { to: withDrawAddress, value }   21k gas
//            value = ethBalance - 21000 * maxFeePerGas (留 buffer 防 fee 浮动)
//
// 用法:
//   node sweep.mjs                       全部钱包, 默认并发 5
//   node sweep.mjs 1-100                 钱包 1-100
//   node sweep.mjs 1 4 8                 指定钱包
//   node sweep.mjs --c=10                并发 (建议 ≤ 10, 防 Infura ratelimit)
//   node sweep.mjs --dry-run             模拟, 打印计划但不发 tx
//   node sweep.mjs --usdt-only           只扫 USDT (留 ETH 给后续操作)
//   node sweep.mjs --eth-only            只扫 ETH
//   node sweep.mjs --min-eth=0.0005      ETH < 此值跳过 (避免 dust 全付了 gas)
//   node sweep.mjs --yes                 跳过 yes 确认
//
// 安全:
//   - withDrawAddress 必须是合法 EVM address, 且 ≠ 钱包自己 (防止空转烧 gas)
//   - cleanupOnStart=true 风格: USDT phase 失败仍尝试 ETH phase (尽量拿回多一点)
//   - 失败钱包末尾打表 + 重跑命令

import fs from "fs";
import readline from "readline";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { Wallet, Contract, isAddress, parseUnits, formatUnits, formatEther } from "ethers";
import { askPassword, loadWallets } from "./lib/cipher.mjs";
import { buildProvider } from "./lib/rpc.mjs";
import { config } from "./config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

process.on("unhandledRejection", (r) => {
    console.warn(`[unhandledRejection 已忽略] ${r?.message?.slice(0, 200) || r}`);
});
process.on("uncaughtException", (e) => {
    console.warn(`[uncaughtException 已忽略] ${e?.message?.slice(0, 200) || e}`);
});

const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function transfer(address to, uint256 value) returns (bool)",
];

const ts = () => new Date().toISOString().slice(11, 19);
const errMsg = e => e?.shortMessage || e?.reason || e?.message || String(e);

// gas 保留: ETH 转账 21000, USDT transfer 大约 60k (USDT 老合约有些情况会到 80k)
const ETH_TRANSFER_GAS = 21000n;
const USDT_TRANSFER_GAS_BUFFER = 80000n;   // 保守估计 USDT.transfer 上限
// EIP-1559 fee buffer (避免 tx 还没打包时 fee bump)
const FEE_BUFFER_NUM = 12n;
const FEE_BUFFER_DEN = 10n;   // × 1.2

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

// 1.2× buffer for maxFeePerGas (EIP-1559)
function bumpFee(fee) {
    return fee == null ? null : (fee * FEE_BUFFER_NUM) / FEE_BUFFER_DEN;
}

async function sendUsdtAll({ wallet, provider, to, log }) {
    const usdt = new Contract(config.deposit.usdt, ERC20_ABI, wallet);
    const [bal, decimals] = await Promise.all([
        usdt.balanceOf(wallet.address),
        usdt.decimals(),
    ]);
    if (bal === 0n) {
        log(`USDT phase: balance=0, 跳过`);
        return { sent: false, amount: "0" };
    }
    const amount = formatUnits(bal, decimals);
    log(`USDT phase: transfer ${amount} USDT → ${to}`);
    // 用钱包当前 nonce; provider.getFeeData() 拿 EIP-1559 fee
    const fee = await provider.getFeeData();
    const overrides = {};
    if (fee.maxFeePerGas) overrides.maxFeePerGas = bumpFee(fee.maxFeePerGas);
    if (fee.maxPriorityFeePerGas) overrides.maxPriorityFeePerGas = bumpFee(fee.maxPriorityFeePerGas);
    const tx = await usdt.transfer(to, bal, overrides);
    log(`USDT tx ${tx.hash} (gasPrice maxFee=${overrides.maxFeePerGas ? formatUnits(overrides.maxFeePerGas, "gwei") + "gwei" : "?"})`);
    const r = await tx.wait();
    log(`USDT ✓ confirmed @ block ${r.blockNumber} gasUsed=${r.gasUsed}`);
    return { sent: true, amount, txHash: tx.hash, gasUsed: r.gasUsed };
}

async function sweepEthAll({ wallet, provider, to, minEth, log }) {
    const [bal, fee] = await Promise.all([
        provider.getBalance(wallet.address),
        provider.getFeeData(),
    ]);
    if (bal === 0n) {
        log(`ETH phase: balance=0, 跳过`);
        return { sent: false, amount: "0" };
    }
    const maxFee = bumpFee(fee.maxFeePerGas);
    if (!maxFee) {
        log(`ETH phase: 无法拿 maxFeePerGas, 跳过`);
        return { sent: false, amount: "0", error: "no fee data" };
    }
    const gasCost = ETH_TRANSFER_GAS * maxFee;
    if (bal <= gasCost) {
        log(`ETH phase: balance ${formatEther(bal)} ≤ gas cost ${formatEther(gasCost)}, 跳过`);
        return { sent: false, amount: formatEther(bal), reason: "below-gas" };
    }
    const value = bal - gasCost;
    if (minEth > 0 && parseFloat(formatEther(value)) < minEth) {
        log(`ETH phase: 可转 ${formatEther(value)} < min ${minEth}, 跳过`);
        return { sent: false, amount: formatEther(value), reason: "below-min" };
    }
    log(`ETH phase: 总额 ${formatEther(bal)}, 转 ${formatEther(value)}, 留 ${formatEther(gasCost)} (gas)`);
    const txReq = {
        to,
        value,
        gasLimit: ETH_TRANSFER_GAS,
        maxFeePerGas: maxFee,
    };
    if (fee.maxPriorityFeePerGas) txReq.maxPriorityFeePerGas = bumpFee(fee.maxPriorityFeePerGas);
    const tx = await wallet.sendTransaction(txReq);
    log(`ETH tx ${tx.hash}`);
    const r = await tx.wait();
    log(`ETH ✓ confirmed @ block ${r.blockNumber}`);
    return { sent: true, amount: formatEther(value), txHash: tx.hash };
}

async function processWallet(w, idx, opts) {
    const { dryRun, usdtOnly, ethOnly, minEth } = opts;
    const tag = `[${String(idx).padStart(4)}] ${w.address.slice(0, 10)}`;
    const log = m => console.log(`[${ts()}] ${tag} ${m}`);

    const to = w.raw?.withDrawAddress;
    if (!to) {
        log(`✗ 缺 withDrawAddress 列, 跳过`);
        return { idx, address: w.address, ok: false, error: "missing withDrawAddress" };
    }
    if (!isAddress(to)) {
        log(`✗ withDrawAddress 非法 ${to}, 跳过`);
        return { idx, address: w.address, ok: false, error: `invalid address: ${to}` };
    }
    if (to.toLowerCase() === w.address.toLowerCase()) {
        log(`✗ withDrawAddress = self, 跳过 (空转烧 gas 无意义)`);
        return { idx, address: w.address, ok: false, error: "withDrawAddress = self" };
    }
    log(`→ ${to}${dryRun ? " [DRY]" : ""}`);

    // Provider 用 deposit 的 sticky Infura 池 (按 address hash, 同一钱包稳定走一个 key)
    const rpcProxy = (config.deposit.rpcUseProxy ?? false) ? w.proxy : null;
    const provider = buildProvider(
        config.deposit.ethRpcUrls ?? config.deposit.ethRpcUrl,
        rpcProxy, w.address,
    );
    const wallet = new Wallet(w.privateKey, provider);

    let usdtResult = null, ethResult = null;
    const errors = [];

    // ---- Phase 1: USDT ----
    if (!ethOnly) {
        try {
            if (dryRun) {
                const usdt = new Contract(config.deposit.usdt, ERC20_ABI, provider);
                const [bal, dec] = await Promise.all([usdt.balanceOf(w.address), usdt.decimals()]);
                if (bal === 0n) log(`[DRY] USDT balance=0, skip`);
                else log(`[DRY] 将 transfer ${formatUnits(bal, dec)} USDT → ${to}`);
                usdtResult = { sent: false, amount: formatUnits(bal, dec), dry: true };
            } else {
                usdtResult = await sendUsdtAll({ wallet, provider, to, log });
            }
        } catch (e) {
            log(`✗ USDT phase 失败: ${errMsg(e)}`);
            errors.push(`usdt: ${errMsg(e)}`);
            // 继续 ETH phase (ETH 没被 USDT tx 消耗多少, 还能尝试取回)
        }
    }

    // ---- Phase 2: ETH ----
    if (!usdtOnly) {
        try {
            if (dryRun) {
                const [bal, fee] = await Promise.all([provider.getBalance(w.address), provider.getFeeData()]);
                const maxFee = bumpFee(fee.maxFeePerGas) ?? 0n;
                const gasCost = ETH_TRANSFER_GAS * maxFee;
                const value = bal > gasCost ? bal - gasCost : 0n;
                if (value === 0n) log(`[DRY] ETH balance ${formatEther(bal)} ≤ gas, skip`);
                else log(`[DRY] 将转 ${formatEther(value)} ETH (留 ${formatEther(gasCost)} gas) → ${to}`);
                ethResult = { sent: false, amount: formatEther(value), dry: true };
            } else {
                ethResult = await sweepEthAll({ wallet, provider, to, minEth, log });
            }
        } catch (e) {
            log(`✗ ETH phase 失败: ${errMsg(e)}`);
            errors.push(`eth: ${errMsg(e)}`);
        }
    }

    const ok = errors.length === 0;
    return {
        idx, address: w.address, withDrawAddress: to, ok,
        usdt: usdtResult,
        eth: ethResult,
        error: errors.length ? errors.join(" | ") : undefined,
    };
}

async function main() {
    const args = process.argv.slice(2);
    const dryRun = args.includes("--dry-run");
    const usdtOnly = args.includes("--usdt-only");
    const ethOnly = args.includes("--eth-only");
    const skipConfirm = args.includes("--yes");
    if (usdtOnly && ethOnly) { console.log("--usdt-only 和 --eth-only 互斥"); process.exit(1); }
    const concurrency = parseInt(parseFlag(args, "concurrency", "c") || "5");
    const minEth = parseFloat(parseFlag(args, "min-eth") || "0");
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

    // 早校验: 所有钱包都有合法 withDrawAddress 且 ≠ self
    const invalid = [];
    for (const w of wallets) {
        const to = w.raw?.withDrawAddress;
        if (!to) invalid.push({ idx: w._origIdx, reason: "缺列" });
        else if (!isAddress(to)) invalid.push({ idx: w._origIdx, reason: `非法 ${to}` });
        else if (to.toLowerCase() === w.address.toLowerCase()) invalid.push({ idx: w._origIdx, reason: "= self" });
    }

    const mode = ethOnly ? "ETH-only" : usdtOnly ? "USDT-only" : "USDT + ETH";
    console.log(`=== 钱包资金回充 ${dryRun ? "(DRY-RUN)" : "实盘"} (${mode}) ===`);
    console.log(`钱包: ${wallets.length}${selected ? ` (${selected.slice(0, 20).join(",")}${selected.length > 20 ? "..." : ""})` : " (全部)"} | 并发: ${concurrency}`);
    if (minEth > 0) console.log(`ETH < ${minEth} 跳过`);
    if (invalid.length) {
        console.log(`\n⚠️ ${invalid.length} 个钱包 withDrawAddress 无效 (会跳过):`);
        for (const x of invalid.slice(0, 20)) console.log(`  [${x.idx}] ${x.reason}`);
        if (invalid.length > 20) console.log(`  ... 还有 ${invalid.length - 20} 个`);
    }
    console.log("");

    if (!dryRun && !skipConfirm) {
        const ok = await confirm(`将对 ${wallets.length - invalid.length} 个钱包发起资金回充, 确认? (yes/no) `);
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
                const r = await processWallet(w, w._origIdx, { dryRun, usdtOnly, ethOnly, minEth });
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
    const usdtSent = all.filter(r => r.usdt?.sent);
    const ethSent = all.filter(r => r.eth?.sent);
    const totalUsdt = usdtSent.reduce((s, r) => s + parseFloat(r.usdt.amount || 0), 0);
    const totalEth = ethSent.reduce((s, r) => s + parseFloat(r.eth.amount || 0), 0);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);

    console.log(`\n${"=".repeat(70)}`);
    console.log(`=== 完成 (${elapsed}s) ===`);
    console.log(`钱包总数:           ${all.length}`);
    console.log(`成功:               ${ok.length}`);
    console.log(`失败:               ${failed.length}`);
    if (!ethOnly)  console.log(`USDT 转账成功:      ${usdtSent.length}  合计 ${totalUsdt.toFixed(2)} USDT`);
    if (!usdtOnly) console.log(`ETH  转账成功:      ${ethSent.length}  合计 ${totalEth.toFixed(6)} ETH`);

    if (failed.length > 0) {
        console.log(`\n失败钱包重跑: node sweep.mjs ${failed.map(f => f.idx).join(" ")}`);
        console.log(`\n失败明细:`);
        for (const f of failed.sort((a, b) => a.idx - b.idx)) {
            console.log(`  [${String(f.idx).padStart(4)}] ${f.address} → ${f.withDrawAddress || "?"}  ${f.error}`);
        }
    }
}

main().then(() => process.exit(0), e => { console.error("fatal:", e); process.exit(1); });
