// 策略 2: 配平 (balance / wash)
// - 随机 2-7 个钱包一组, 同一 symbol 上 kLong 买 + kShort 卖
// - 每边 notional 总和相等 (kLong*longN == kShort*shortN)
// - 全员立即开 -> 短暂持有 -> 全员平仓
// - 单次 run 一组 session, 每钱包当日只参与一次 balance
//
// meta.type = "group", trade.mjs 会把候选 wallet 列表全交给它

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));

function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function selectSymbol(exchangeInfo, opts) {
    const { prefixes, underlyings, longNotional, shortNotional } = opts;
    const minNeeded = Math.max(longNotional, shortNotional);
    let candidates = exchangeInfo.symbols.filter(s => {
        if (s.isExpired || s.isLockedUp || s.pausedOrders) return false;
        if (parseFloat(s.minTradeNotional) > minNeeded) return false;
        if (s.productType !== "funding-rate-futures") return false;
        if (underlyings && !underlyings.includes(s.underlyingAsset)) return false;
        return true;
    });
    for (const p of prefixes) {
        const hit = candidates.filter(s => s.symbol.startsWith(p));
        if (hit.length) { candidates = hit; break; }
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => new Date(a.maturityDate) - new Date(b.maturityDate));
    const byU = {};
    for (const s of candidates) (byU[s.underlyingAsset] ??= []).push(s);
    const underlying = pick(Object.keys(byU));
    return pick(byU[underlying].slice(0, 2));
}

function tradeRecord(t) {
    if (!t) return null;
    return {
        side: t.side,
        price: t.price,
        volume: t.volume,
        fee: t.tradingFees,
        time: t.time,
        orderId: t.orderId,
    };
}

function estimatePnl(open, close) {
    if (!open || !close) return null;
    const dir = open.side === "buy" ? 1 : -1;
    const gross = (parseFloat(close.price) - parseFloat(open.price)) * parseFloat(open.volume) * dir;
    const fees = parseFloat(open.tradingFees) + parseFloat(close.tradingFees);
    return { gross: gross.toFixed(4), fees: fees.toFixed(4), net: (gross + fees).toFixed(4) };
}

function fmtErr(e) {
    if (e?.response) return `${e.response.status} ${JSON.stringify(e.response.data)}`;
    return e?.message || String(e);
}

export const meta = { type: "group", perDay: true, name: "balance" };

// ctx: { candidates: [{address, privateKey}], getClient, exchangeInfo, config, log }
// 返回 [{ address, record }, ...]
export async function executeGroup(ctx) {
    const { candidates, getClient, exchangeInfo, config, log } = ctx;
    const cfg = config.balance;

    if (candidates.length < cfg.minWallets) {
        log(`候选钱包 ${candidates.length} < minWallets ${cfg.minWallets}, 跳过`);
        return [];
    }

    const groupSize = randInt(cfg.minWallets, Math.min(cfg.maxWallets, candidates.length));
    const group = shuffle(candidates).slice(0, groupSize);
    const kLong = randInt(1, groupSize - 1);
    const kShort = groupSize - kLong;
    const longNotional = cfg.unitNotional * kShort;
    const shortNotional = cfg.unitNotional * kLong;

    const sym = selectSymbol(exchangeInfo, {
        prefixes: cfg.symbolPrefixes,
        underlyings: cfg.underlyings,
        longNotional,
        shortNotional,
    });
    if (!sym) {
        const err = `no candidate symbol for split kL=${kLong} kS=${kShort} (longN=${longNotional} shortN=${shortNotional})`;
        log(err);
        return group.map(w => ({
            address: w.address,
            record: { strategy: "balance", status: "failed", error: err, ts: new Date().toISOString() },
        }));
    }

    const sessionId = `b${Date.now().toString(36)}`;
    log(`session=${sessionId} symbol=${sym.symbol} n=${groupSize}: ${kLong}L*$${longNotional} + ${kShort}S*$${shortNotional}`);

    // 分配 side
    const assignments = group.map((w, i) => ({
        wallet: w,
        side: i < kLong ? "buy" : "sell",
        notional: i < kLong ? longNotional : shortNotional,
    }));

    // 1) 全员登录 (并发)
    const withClient = await Promise.all(assignments.map(async a => {
        try {
            const client = await getClient(a.wallet);
            return { ...a, client };
        } catch (e) {
            return { ...a, error: `login: ${fmtErr(e)}` };
        }
    }));

    // 2) 全员开仓 (并发)
    const opened = await Promise.all(withClient.map(async a => {
        if (a.error) return a;
        const cid = `${sessionId}${a.wallet.address.slice(2, 8)}`.slice(0, 36);
        const body = {
            orderType: "market",
            symbol: sym.symbol,
            side: a.side,
            quantity: String(a.notional),
            timeInForce: "IOC",
            clientOrderId: cid,
        };
        try {
            const r = await a.client.createOrder(body);
            const tr = r.trades?.[0];
            if (!tr) throw new Error(`no trade in resp: ${JSON.stringify(r).slice(0, 200)}`);
            log(`  open ${a.wallet.address.slice(0, 10)} ${a.side} $${a.notional} fill=${tr.price} fee=${tr.tradingFees}`);
            return { ...a, openTrade: tr };
        } catch (e) {
            log(`  open FAIL ${a.wallet.address.slice(0, 10)}: ${fmtErr(e)}`);
            return { ...a, error: `open: ${fmtErr(e)}` };
        }
    }));

    // 3) 持有 holdSecondsRange
    const hold = randInt(cfg.holdSecondsRange[0], cfg.holdSecondsRange[1]);
    if (hold > 0) {
        log(`持有 ${hold}s ...`);
        await sleep(hold * 1000);
    }

    // 4) 全员平仓 (close-position flag, 不带 side)
    const closed = await Promise.all(opened.map(async a => {
        if (a.error || !a.openTrade) return a;
        const cid = `${sessionId}${a.wallet.address.slice(2, 8)}c`.slice(0, 36);
        try {
            const r = await a.client.createOrder({
                orderType: "market",
                symbol: sym.symbol,
                timeInForce: "IOC",
                flags: ["close-position"],
                clientOrderId: cid,
            });
            const tr = r.trades?.[0];
            if (!tr) throw new Error(`no trade in resp: ${JSON.stringify(r).slice(0, 200)}`);
            log(`  close ${a.wallet.address.slice(0, 10)} fill=${tr.price} fee=${tr.tradingFees}`);
            return { ...a, closeTrade: tr };
        } catch (e) {
            log(`  close FAIL ${a.wallet.address.slice(0, 10)}: ${fmtErr(e)}`);
            return { ...a, error: `close: ${fmtErr(e)} (open 已成交, 启动时清理 phase 会平掉)` };
        }
    }));

    // 5) 组装结果
    return closed.map(a => {
        const base = {
            strategy: "balance",
            sessionId,
            symbol: sym.symbol,
            ts: new Date().toISOString(),
            side: a.side,
            notional: a.notional,
            open: tradeRecord(a.openTrade),
            close: tradeRecord(a.closeTrade),
        };
        if (a.error) {
            return { address: a.wallet.address, record: { ...base, status: "failed", error: a.error } };
        }
        return {
            address: a.wallet.address,
            record: { ...base, status: "ok", pnl: estimatePnl(a.openTrade, a.closeTrade) },
        };
    });
}
