// 单钱包一次性测试: 登录 -> 查余额/持仓 -> 开空 -> 立即平仓
//
// 用法:
//   node test-trade.mjs <privateKey> [symbol] [notional]
//   --dry  只打 payload 不下单
//   --live 实盘下单（默认是 --dry）
//
// 例:
//   node test-trade.mjs 0xf1d7... BINANCE-BTCUSDT:29MAY26 100 --dry
//   node test-trade.mjs 0xf1d7... BINANCE-BTCUSDT:29MAY26 100 --live

import { Wallet, JsonRpcProvider, Contract, formatUnits, formatEther } from "ethers";
import { RhoClient } from "./lib/rho.mjs";
import { config } from "./config.mjs";

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith("--")));
const pos = args.filter(a => !a.startsWith("--"));
const PK = pos[0];
const SYMBOL = pos[1] ?? "BINANCE-BTCUSDT:29MAY26";
const NOTIONAL = pos[2] ? parseFloat(pos[2]) : 100;
const LIVE = flags.has("--live");

if (!PK || !PK.startsWith("0x") || PK.length !== 66) {
    console.log("用法: node test-trade.mjs 0x<64位私钥> [symbol] [notional] [--live|--dry]");
    process.exit(1);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ts = () => new Date().toISOString().slice(11, 19);
const errMsg = e => e?.response ? `${e.response.status} ${JSON.stringify(e.response.data)}` : e?.message;

const ERC20 = [
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
];

async function onChainBalances(addr) {
    const provider = new JsonRpcProvider(config.deposit.ethRpcUrl);
    const usdt = new Contract(config.deposit.usdt, ERC20, provider);
    const [eth, bal] = await Promise.all([
        provider.getBalance(addr),
        usdt.balanceOf(addr),
    ]);
    return {
        eth: formatEther(eth),
        usdt: formatUnits(bal, 6),
    };
}

async function main() {
    const wallet = new Wallet(PK);
    console.log(`[${ts()}] address: ${wallet.address}`);
    console.log(`[${ts()}] mode   : ${LIVE ? "LIVE 实盘" : "DRY 仅打印"}`);
    console.log(`[${ts()}] symbol : ${SYMBOL}`);
    console.log(`[${ts()}] qty    : ${NOTIONAL} (按 quantity = notional USDT 推断)`);

    // 1) 链上余额
    const onchain = await onChainBalances(wallet.address);
    console.log(`[${ts()}] onchain ETH=${onchain.eth} USDT=${onchain.usdt}`);

    // 2) Rho 登录
    const client = new RhoClient({ apiBase: config.apiBase, privateKey: PK });
    await client.login();
    console.log(`[${ts()}] login ok`);

    // 3) 协议侧余额 + 持仓
    try {
        const ma = await client.listMarginAccounts();
        const funding = ma.userMarginAccounts?.find(a => a.marginAccount === "funding");
        if (funding) {
            console.log(`[${ts()}] funding 账户: total=${funding.totalMargin} withdrawable=${funding.withdrawableBalance} im=${funding.initialMarginRequirement} mm=${funding.maintenanceMarginRequirement}`);
        } else {
            console.log(`[${ts()}] 未找到 funding margin account`);
        }
    } catch (e) { console.log(`[${ts()}] margin-accounts err: ${errMsg(e)}`); }

    let posBefore;
    try {
        posBefore = (await client.getPositions()).positions ?? [];
        console.log(`[${ts()}] 现有持仓: ${posBefore.length} 笔`);
        for (const p of posBefore) console.log("    " + JSON.stringify(p).slice(0, 200));
    } catch (e) { console.log(`[${ts()}] positions err: ${errMsg(e)}`); }

    // 4) symbol metadata
    const info = await client.getExchangeInfo();
    const sym = info.symbols?.find(s => s.symbol === SYMBOL);
    if (!sym) {
        console.log(`[${ts()}] symbol "${SYMBOL}" 不存在! 候选 BTC:`);
        for (const s of info.symbols.filter(s => /BTC/i.test(s.symbol))) console.log("   " + s.symbol);
        process.exit(1);
    }
    console.log(`[${ts()}] symbol meta: minNotional=${sym.minTradeNotional} priceTickSize=${sym.priceTickSize} takerFee=${sym.takerFeeFactor} (min ${sym.minTakerFee}) IMdelta=${sym.initialMarginThresholdDelta}`);

    if (NOTIONAL < parseFloat(sym.minTradeNotional)) {
        console.log(`[${ts()}] !!! ${NOTIONAL} < minTradeNotional ${sym.minTradeNotional}, 会被拒`);
        process.exit(1);
    }

    // 5) ticker
    let tk;
    try {
        tk = await client.getTicker(SYMBOL);
        const t = tk.ticker ?? tk;
        console.log(`[${ts()}] ticker bid=${t.bidPrice}@${t.bidSize} ask=${t.askPrice}@${t.askSize} mark=${t.markPrice} last=${t.lastPrice}`);
    } catch (e) { console.log(`[${ts()}] ticker err: ${errMsg(e)}`); process.exit(1); }

    // 6) 开空 (sell)
    const cid = `t${Date.now()}`;
    const openBody = {
        orderType: "market",
        symbol: SYMBOL,
        side: "sell",
        quantity: String(NOTIONAL),
        timeInForce: "IOC",
        clientOrderId: cid,
    };
    console.log(`[${ts()}] open payload: ${JSON.stringify(openBody)}`);
    if (!LIVE) {
        console.log(`[${ts()}] DRY: 跳过实际下单。要实盘加 --live`);
        return;
    }

    let openResp;
    try {
        openResp = await client.createOrder(openBody);
        console.log(`[${ts()}] open resp: ${JSON.stringify(openResp).slice(0, 600)}`);
    } catch (e) {
        console.log(`[${ts()}] open 失败: ${errMsg(e)}`);
        return;
    }

    // 7) 立即平仓
    await sleep(500);
    const closeBody = {
        orderType: "market",
        symbol: SYMBOL,
        side: "buy",
        quantity: String(NOTIONAL),
        timeInForce: "IOC",
        flags: ["close-position"],
        clientOrderId: cid + "c",
    };
    console.log(`[${ts()}] close payload: ${JSON.stringify(closeBody)}`);
    let closeResp;
    try {
        closeResp = await client.createOrder(closeBody);
        console.log(`[${ts()}] close resp: ${JSON.stringify(closeResp).slice(0, 600)}`);
    } catch (e) {
        console.log(`[${ts()}] close 失败: ${errMsg(e)}`);
    }

    // 8) 确认仓位归零
    await sleep(2000);
    try {
        const after = (await client.getPositions()).positions ?? [];
        console.log(`[${ts()}] 平仓后持仓: ${after.length} 笔`);
        for (const p of after) console.log("    " + JSON.stringify(p).slice(0, 200));
    } catch (e) { console.log(`[${ts()}] positions(after) err: ${errMsg(e)}`); }

    try {
        const ma = await client.listMarginAccounts();
        const f = ma.userMarginAccounts?.find(a => a.marginAccount === "funding");
        if (f) console.log(`[${ts()}] funding 账户(after): total=${f.totalMargin} withdrawable=${f.withdrawableBalance} pnl=${f.totalPnl} fees=${f.tradingFees}`);
    } catch {}

    console.log(`[${ts()}] === 完成 ===`);
}

main().catch(e => { console.error("FATAL:", errMsg(e)); process.exit(1); });
