import { fileURLToPath } from "url";
import { dirname } from "path";
import { parseEther, parseUnits, formatUnits } from "ethers";
import { HttpsProxyAgent } from "https-proxy-agent";
import { askPassword, loadWallets } from "./lib/cipher.mjs";
import { RhoDeposit, fmtToken, fmtEth } from "./lib/deposit.mjs";
import { LiFiSwap } from "./lib/swap.mjs";
import { RhoClient } from "./lib/rho.mjs";
import { config } from "./config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 19);
const errMsg = e => e?.shortMessage || e?.info?.error?.message || e?.message || String(e);

// CLI flag: --amount=N 覆盖 deposit 数量上限 (用于测试时控制风险)
function parseAmountFlag(args) {
    for (const a of args) {
        const m = a.match(/^--amount=(.+)$/);
        if (m) {
            const n = parseFloat(m[1]);
            if (!isFinite(n) || n <= 0) { console.log(`--amount 无效: ${m[1]}`); process.exit(1); }
            return n;
        }
    }
    return null;
}

function makeProxyAgent(walletProxy) {
    if (!walletProxy) return null;
    const auth = walletProxy.username
        ? `${encodeURIComponent(walletProxy.username)}:${encodeURIComponent(walletProxy.password)}@`
        : "";
    return new HttpsProxyAgent(`http://${auth}${walletProxy.host}:${walletProxy.port}`);
}

// 模拟前端登录三连: /nonce → /login → /users/account → /auth-api/v1/me
// 必须在 swap/deposit 链上动作 *之前* 跑, 否则 indexer 漏 deposit event
async function activateRhoUser(wallet, log) {
    const client = new RhoClient({
        apiBase: config.apiBase,
        privateKey: wallet.privateKey,
        httpAgent: makeProxyAgent(wallet.proxy),
    });
    await client.login();
    log(`Rho activated: userId=${client.userInfo?.userId?.slice(0, 8) ?? "?"}...`);
    return client;
}

async function processWallet(rho, swap, wallet, idx, amountCap) {
    const tag = `[${idx}] ${wallet.address.slice(0, 10)}`;
    const log = msg => console.log(`[${ts()}] ${tag} ${msg}`);

    // Phase 0: 先激活 Rho user (跑前端登录流程, indexer 才会认领后续 deposit)
    // !! 失败必须 return, 否则 swap+deposit 链上 OK 但协议侧不 credit, 资金永久丢失
    // (参考 wallet 2 第一笔 25.86 USDT 案例)
    try {
        await activateRhoUser(wallet, log);
    } catch (e) {
        log(`✗ Rho 激活失败: ${errMsg(e)} - 跳过此钱包 (防止 deposit 进 vault 但协议不 credit)`);
        return { ok: false, error: `activate: ${errMsg(e)}`, retryable: true };
    }

    let pf;
    try {
        pf = await rho.preflight(wallet, config.deposit.amountUsdt, config.deposit.minEthForGas);
    } catch (e) {
        log(`preflight 失败: ${errMsg(e)}`);
        return { ok: false };
    }

    console.log(
        `[${ts()}] ${tag} ETH=${fmtEth(pf.ethBal)} USDT=${fmtToken(pf.usdtBal, pf.decimals)} ` +
        `allowance=${pf.allowance >= 2n ** 200n ? "∞" : fmtToken(pf.allowance, pf.decimals)}`
    );

    // === Phase 1: ETH -> USDT 自动 swap ===
    if (swap && config.swap?.enabled) {
        const minEthToSwap = parseEther(String(config.swap.minEthToSwap));
        const reserve = parseEther(String(config.swap.leaveEthForGas));
        if (pf.ethBal > minEthToSwap && pf.ethBal > reserve) {
            const amount = pf.ethBal - reserve;
            console.log(`[${ts()}] ${tag} Phase 1: swap ${fmtEth(amount)} ETH -> USDT (reserve ${config.swap.leaveEthForGas} ETH)`);
            if (config.deposit.dryRun) {
                console.log(`[${ts()}] ${tag} [DRY] 跳过 swap (dryRun)`);
            } else {
                try {
                    const r = await swap.swapEthToUsdt({
                        privateKey: wallet.privateKey,
                        walletAddress: wallet.address,
                        amountWei: amount,
                        walletProxy: wallet.proxy,
                    });
                    console.log(`[${ts()}] ${tag} swap tx ${r.tx.hash} via ${r.tool}, expect ${formatUnits(r.toAmountExpected, 6)} USDT (min ${formatUnits(r.toAmountMin, 6)})`);
                    const rec = await r.tx.wait();
                    if (rec.status !== 1) throw new Error(`swap revert (${r.tx.hash})`);
                    console.log(`[${ts()}] ${tag} swap confirmed @ block ${rec.blockNumber}, gas=${rec.gasUsed}`);
                    await sleep(config.swap.waitAfterSwapMs ?? 3000);
                    pf = await rho.preflight(wallet, config.deposit.amountUsdt, config.deposit.minEthForGas);
                    console.log(`[${ts()}] ${tag} swap 后 ETH=${fmtEth(pf.ethBal)} USDT=${fmtToken(pf.usdtBal, pf.decimals)}`);
                } catch (e) {
                    console.log(`[${ts()}] ${tag} swap 失败: ${errMsg(e)} (用现有 USDT 继续)`);
                }
            }
        } else {
            console.log(`[${ts()}] ${tag} Phase 1: ETH ${fmtEth(pf.ethBal)} 不够 swap (min ${config.swap.minEthToSwap} / reserve ${config.swap.leaveEthForGas})`);
        }
    }

    // === Phase 2: deposit USDT -> Rho funding ===
    if (!pf.ethOk) {
        console.log(`[${ts()}] ${tag} 跳过：ETH 不足以支付 gas (< ${config.deposit.minEthForGas})`);
        return { ok: false, skipped: true, reason: "eth_low" };
    }
    if (!pf.usdtOk) {
        console.log(`[${ts()}] ${tag} 跳过：USDT 余额 ${fmtToken(pf.usdtBal, pf.decimals)} < 阈值 ${config.deposit.amountUsdt}`);
        return { ok: false, skipped: true, reason: "usdt_low" };
    }

    // deposit 数量: 默认全部余额; 若有 --amount=N 则 min(余额, N)
    let depositAmount = pf.usdtBal;
    let modeNote = "(全部余额)";
    if (amountCap != null) {
        const capRaw = parseUnits(String(amountCap), pf.decimals);
        if (capRaw < depositAmount) {
            depositAmount = capRaw;
            modeNote = `(--amount=${amountCap} 上限)`;
        } else {
            modeNote = `(余额 ${fmtToken(pf.usdtBal, pf.decimals)} < cap ${amountCap}, 全部存)`;
        }
    }
    const depositHuman = fmtToken(depositAmount, pf.decimals);

    if (config.deposit.dryRun) {
        const calldata = rho.encodeDepositCalldata(wallet.address, depositAmount, Math.floor(Date.now() / 1000) + config.deposit.deadlineSeconds);
        console.log(`[${ts()}] ${tag} [DRY] approve(MaxUint256) -> ${rho.gatewayAddr}`);
        console.log(`[${ts()}] ${tag} [DRY] deposit ${depositHuman} USDT (calldata ${calldata.length / 2 - 1}B): ${calldata.slice(0, 80)}...`);
        return { ok: true };
    }

    // approveMax 一次到顶, 之后 allowance=∞ 直接跳过, 节省 gas
    if (pf.allowance < depositAmount) {
        try {
            console.log(`[${ts()}] ${tag} approve(MaxUint256) ... (allowance ${fmtToken(pf.allowance, pf.decimals)} < ${depositHuman})`);
            const tx = await rho.approveMax(wallet);
            console.log(`[${ts()}] ${tag} approve tx ${tx.hash}`);
            const r = await tx.wait();
            if (r.status !== 1) throw new Error(`approve revert (${tx.hash})`);
            console.log(`[${ts()}] ${tag} approve confirmed @ block ${r.blockNumber}`);
        } catch (e) {
            console.log(`[${ts()}] ${tag} approve 失败: ${errMsg(e)}`);
            return { ok: false };
        }
    } else {
        console.log(`[${ts()}] ${tag} approve 已存在 (allowance=∞), 跳过, 省 ~$0.30 gas`);
    }

    try {
        console.log(`[${ts()}] ${tag} deposit ${depositHuman} USDT ${modeNote} ...`);
        const { tx } = await rho.deposit(wallet, depositAmount);
        console.log(`[${ts()}] ${tag} deposit tx ${tx.hash}`);
        const r = await tx.wait();
        if (r.status !== 1) throw new Error(`deposit revert (${tx.hash})`);
        console.log(`[${ts()}] ${tag} deposit confirmed @ block ${r.blockNumber}, gas=${r.gasUsed}`);
        return { ok: true };
    } catch (e) {
        console.log(`[${ts()}] ${tag} deposit 失败: ${errMsg(e)}`);
        return { ok: false };
    }
}

// 解析钱包选择参数:
//   "1-3"          -> [1, 2, 3]
//   "10 17"        -> [10, 17]
//   "1-3 10 17"    -> [1, 2, 3, 10, 17]
//   单独 "5"       -> [5]
//   不传任何参数   -> null (= 全部)
function parseSelectors(args, max) {
    // 跳过 -- 开头的 flag (如 --amount=10), 只看 selector tokens
    const tokens = args
        .filter(a => !a.startsWith("--"))
        .flatMap(a => String(a).split(/\s+/)).filter(Boolean);
    if (!tokens.length) return null;
    const set = new Set();
    for (const t of tokens) {
        const m = t.match(/^(\d+)(?:-(\d+))?$/);
        if (!m) { console.log(`无法识别 "${t}". 用法示例: 1 / 1-3 / "10 17" / "1-3 10 17"`); process.exit(1); }
        const a = parseInt(m[1]);
        const b = m[2] ? parseInt(m[2]) : a;
        if (a < 1 || b < a || a > max) { console.log(`范围 ${t} 无效, 共 ${max} 个钱包`); process.exit(1); }
        for (let i = a; i <= Math.min(b, max); i++) set.add(i);
    }
    return [...set].sort((x, y) => x - y);
}

async function main() {
    const password = await askPassword("请输入解密密码: ");
    let wallets;
    try {
        wallets = loadWallets(__dirname, password);
    } catch (e) {
        console.log("解密失败:", e.message);
        process.exit(1);
    }

    const cliArgs = process.argv.slice(2);
    const amountCap = parseAmountFlag(cliArgs);
    // 按 CLI 参数筛选钱包 (1-indexed)
    const selected = parseSelectors(cliArgs, wallets.length);
    if (selected) {
        wallets = selected.map(i => ({ ...wallets[i - 1], _origIdx: i }));
    } else {
        wallets = wallets.map((w, i) => ({ ...w, _origIdx: i + 1 }));
    }

    const dep = config.deposit;
    const sw = config.swap;
    console.log("=== Rho-X 入金管线: swap (ETH→USDT) -> deposit (USDT→funding) ===");
    console.log(`钱包数: ${wallets.length}${selected ? ` (按 selector 筛选: ${selected.join(",")})` : " (全部)"} | 并发: ${dep.concurrency} | 最小 deposit: ${dep.amountUsdt} USDT`);
    if (amountCap != null) console.log(`!! --amount=${amountCap} 已设置, 单钱包 deposit 上限 ${amountCap} USDT (覆盖默认"全部余额")`);
    console.log(`swap: enabled=${sw?.enabled} minEth=${sw?.minEthToSwap} reserve=${sw?.leaveEthForGas} integrator=${sw?.integrator}`);
    console.log(`gateway: ${dep.gateway}`);
    console.log(`marketId: ${dep.marketId}`);
    console.log(`dryRun: ${dep.dryRun}`);
    if (!dep.dryRun) {
        console.log("\n!!! dryRun=false，将广播真实交易，5 秒后开始，Ctrl+C 取消 !!!");
        await sleep(5000);
    }
    console.log("");

    const rho = new RhoDeposit({
        rpcUrl: dep.ethRpcUrls ?? dep.ethRpcUrl,
        gateway: dep.gateway,
        token: dep.usdt,
        marketId: dep.marketId,
        tag: dep.tag,
        deadlineSeconds: dep.deadlineSeconds,
        useProxy: dep.rpcUseProxy ?? false,
    });

    const swap = sw?.enabled ? new LiFiSwap({
        rpcUrl: dep.ethRpcUrls ?? dep.ethRpcUrl,
        integrator: sw.integrator,
        slippage: sw.slippage,
        useProxy: dep.rpcUseProxy ?? false,
    }) : null;

    const queue = wallets.map(w => ({ ...w, idx: w._origIdx }));
    let okCount = 0, failCount = 0, skipCount = 0;
    const skippedDetails = { eth_low: 0, usdt_low: 0 };
    const failedList = [];   // {idx, address, error}
    const skippedList = [];  // {idx, address, reason}

    const workers = [];
    for (let i = 0; i < Math.min(dep.concurrency, wallets.length); i++) {
        workers.push((async () => {
            while (queue.length) {
                const w = queue.shift();
                if (!w) break;
                const r = await processWallet(rho, swap, w, w.idx, amountCap);
                if (r.ok) okCount++;
                else if (r.skipped) {
                    skipCount++;
                    if (r.reason && skippedDetails[r.reason] != null) skippedDetails[r.reason]++;
                    skippedList.push({ idx: w.idx, address: w.address, reason: r.reason });
                } else {
                    failCount++;
                    failedList.push({ idx: w.idx, address: w.address, error: r.error || "(unknown)" });
                }
            }
        })());
    }
    await Promise.all(workers);

    console.log(`\n=== 完成: 成功 ${okCount} | 跳过 ${skipCount} (eth_low ${skippedDetails.eth_low}, usdt_low ${skippedDetails.usdt_low}) | 失败 ${failCount} ===`);

    if (failedList.length > 0) {
        console.log(`\n${"=".repeat(70)}`);
        console.log(`✗ 失败钱包明细 (${failedList.length} 个, 重跑会自动重试):`);
        failedList.sort((a, b) => a.idx - b.idx);
        for (const f of failedList) {
            console.log(`  [${String(f.idx).padStart(4)}] ${f.address}  ${f.error}`);
        }
        const idxList = failedList.map(f => f.idx).join(",");
        console.log(`\n重跑命令: node deposit.mjs ${idxList}`);
    }

    if (skippedList.length > 0 && skippedList.length <= 30) {
        console.log(`\n⊘ 跳过钱包明细 (${skippedList.length} 个):`);
        skippedList.sort((a, b) => a.idx - b.idx);
        for (const s of skippedList) {
            console.log(`  [${String(s.idx).padStart(4)}] ${s.address}  ${s.reason}`);
        }
    } else if (skippedList.length > 30) {
        console.log(`\n⊘ 跳过 ${skippedList.length} 个钱包 (太多不列, 可用 verify.mjs 看)`);
    }
}

main().catch(e => {
    console.error("fatal:", e);
    process.exit(1);
});
