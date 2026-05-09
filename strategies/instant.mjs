// 策略 1: 秒开秒关
// - 多市场随机 (按 prefix UNION + underlying 过滤)
// - 每钱包过去 N 天 (默认 7) 交易过的市场会被记下,
//   不足 minDistinctMarketsPerWeek (默认 3) 时强制从"未交易"候选里选
// - 满足覆盖目标后回归纯随机
// - 用 close-position flag 平仓, 单钱包单次执行
//
// meta.type = "perWallet", trade.mjs 给每个钱包独立调用 execute(client, ctx)

import { dayKey, getDayRuns } from "../lib/state.mjs";

export const meta = { type: "perWallet", perDay: true, name: "instant" };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

// 从 symbol 提取 market id (去掉 :MATURITY 后缀, 同市场不同到期视为同一个)
const symbolToMarket = s => s?.split(":")[0] ?? s;

// 列出过去 N 天 today 倒推的 dayKey 列表
function pastDayKeys(today, lookback, boundary) {
    const base = new Date(today + "T12:00:00");
    const out = [];
    for (let d = 0; d < lookback; d++) {
        const date = new Date(base);
        date.setDate(date.getDate() - d);
        out.push(dayKey(date, boundary));
    }
    return out;
}

// 该钱包过去 lookback 天里 status=ok 的所有不同 market
function tradedMarkets({ state, address, today, lookback, boundary, strategyName }) {
    if (!state || !address || !today) return new Set();
    const markets = new Set();
    const runs = state[address.toLowerCase()]?.runs ?? {};
    for (const day of pastDayKeys(today, lookback, boundary)) {
        const r = runs[day]?.[strategyName];
        if (r?.status === "ok" && r.symbol) {
            markets.add(symbolToMarket(r.symbol));
        }
    }
    return markets;
}

// 检查 ticker 盘口是否合格 (秒开秒关需要紧 spread + 充足深度)
function passesLiquidityCheck(ticker, opts) {
    if (!ticker) return { ok: false, why: "no-ticker" };
    const bid = parseFloat(ticker.bidPrice);
    const ask = parseFloat(ticker.askPrice);
    const bidSize = parseFloat(ticker.bidSize);
    const askSize = parseFloat(ticker.askSize);
    if (![bid, ask, bidSize, askSize].every(Number.isFinite)) {
        return { ok: false, why: "incomplete-ticker" };
    }
    const spread = ask - bid;
    if (spread > opts.maxSpread) return { ok: false, why: `spread ${spread.toFixed(4)} > ${opts.maxSpread}` };
    const need = opts.notional * opts.minLiquidityMultiplier;
    if (bidSize < need) return { ok: false, why: `bidSize ${bidSize} < ${need}` };
    if (askSize < need) return { ok: false, why: `askSize ${askSize} < ${need}` };
    return { ok: true, spread, bidSize, askSize };
}

// 收集当天已交易的 markets (用于 avoidSameMarketSameDay)
function todayMarkets(state, address, today, strategyName) {
    const markets = new Set();
    for (const r of getDayRuns(state, address, today, strategyName)) {
        if (r?.status === "ok" && r.symbol) markets.add(symbolToMarket(r.symbol));
    }
    return markets;
}

// 选 symbol: prefix UNION + underlying 过滤 + 活跃 + spread/流动性 + 多样性强制
function selectSymbol(exchangeInfo, tickers, opts) {
    const { prefixes, underlyings, notional, traded, minDistinct, maxSpread, minLiquidityMultiplier, todayMs, avoidSameMarketSameDay } = opts;
    let candidates = exchangeInfo.symbols.filter(s => {
        if (s.isExpired || s.isLockedUp || s.pausedOrders) return false;
        if (parseFloat(s.minTradeNotional) > notional) return false;
        if (s.productType !== "funding-rate-futures") return false;
        if (underlyings && !underlyings.includes(s.underlyingAsset)) return false;
        return true;
    });

    // prefix UNION (任一 prefix 命中即保留, 不再 priority break)
    if (prefixes?.length) {
        candidates = candidates.filter(s => prefixes.some(p => s.symbol.startsWith(p)));
    }
    if (!candidates.length) return null;

    // spread + 流动性过滤 (秒开秒关核心: 深度不够会吃多档滑点)
    if (tickers && (maxSpread != null || minLiquidityMultiplier != null)) {
        const liqOpts = {
            maxSpread: maxSpread ?? Infinity,
            notional,
            minLiquidityMultiplier: minLiquidityMultiplier ?? 1,
        };
        const filtered = candidates.filter(s => passesLiquidityCheck(tickers[s.symbol], liqOpts).ok);
        if (filtered.length === 0) {
            // 全部不合格, 返回 null 让上层 skip 此钱包 (而非乱选)
            return null;
        }
        candidates = filtered;
    }

    // 同日去重: 今天已交易过的 market 排除 (用于 runsPerDay > 1)
    if (avoidSameMarketSameDay && todayMs && todayMs.size > 0) {
        const fresh = candidates.filter(s => !todayMs.has(s.market));
        if (fresh.length > 0) candidates = fresh;
        // else: 今日所有 market 都跑过了 (极少见, 只有 candidate < runsPerDay 时), 允许重复
    }

    // 多样性: 一周内已交易市场数 < minDistinct → 优先未交易过的候选
    const tradedCount = traded?.size ?? 0;
    if (traded && minDistinct > 0 && tradedCount < minDistinct) {
        const untraded = candidates.filter(s => !traded.has(s.market));
        if (untraded.length > 0) candidates = untraded;
    }

    // 同 maturity 选取
    candidates.sort((a, b) => new Date(a.maturityDate) - new Date(b.maturityDate));
    const byUnderlying = {};
    for (const s of candidates) (byUnderlying[s.underlyingAsset] ??= []).push(s);
    const underlying = pick(Object.keys(byUnderlying));
    return pick(byUnderlying[underlying].slice(0, 2));
}

function pickSide(cfg) {
    if (cfg.side === "long") return "buy";
    if (cfg.side === "short") return "sell";
    return Math.random() < 0.5 ? "buy" : "sell";
}

const randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));

// 决定单笔 notional: 区间 [min,max] 随机, 或单值兼容
function pickNotional(cfg) {
    if (Array.isArray(cfg.notionalUsdRange) && cfg.notionalUsdRange.length === 2) {
        const [a, b] = cfg.notionalUsdRange;
        return randInt(Math.min(a, b), Math.max(a, b));
    }
    return cfg.notionalUsd ?? 100;
}

export async function execute(client, ctx) {
    const { wallet, log, config, exchangeInfo, tickers, state, today, dayBoundary } = ctx;
    const cfg = config.instant;
    const lookback = cfg.lookbackDays ?? 7;
    const minDistinct = cfg.minDistinctMarketsPerWeek ?? 3;

    // 多样性: 看过去 N 天本钱包成功过的市场 (含今天)
    const traded = tradedMarkets({
        state, address: wallet.address, today,
        lookback, boundary: dayBoundary ?? "local",
        strategyName: meta.name,
    });
    if (traded.size > 0) {
        log(`过去 ${lookback} 天交易过 ${traded.size}/${minDistinct} 个不同市场: [${[...traded].join(", ")}]`);
    }

    // 同日去重: 今天本钱包已交易过的 markets (runsPerDay > 1 时用)
    const todayMs = todayMarkets(state, wallet.address, today, meta.name);
    if (todayMs.size > 0) {
        log(`今日已交易 ${todayMs.size} 个 market: [${[...todayMs].join(", ")}], 本次将避开`);
    }

    // 本次随机 notional (区间内一次决定, 整笔 open+close 用同一个值)
    const notional = pickNotional(cfg);

    const sym = selectSymbol(exchangeInfo, tickers, {
        prefixes: cfg.symbolPrefixes,
        underlyings: cfg.underlyings,
        notional,
        traded,
        minDistinct,
        maxSpread: cfg.maxSpread,
        minLiquidityMultiplier: cfg.minLiquidityMultiplier,
        todayMs,
        avoidSameMarketSameDay: cfg.avoidSameMarketSameDay ?? true,
    });
    if (!sym) {
        return { ok: false, error: `no candidate symbol (spread<=${cfg.maxSpread}, liq>=${notional}*${cfg.minLiquidityMultiplier})`, retryable: true };
    }
    // 把命中的 ticker 信息打出来便于核对
    const t = tickers?.[sym.symbol];
    if (t) {
        const spread = (parseFloat(t.askPrice) - parseFloat(t.bidPrice)).toFixed(4);
        log(`pick ${sym.symbol} spread=${spread} bid=${t.bidPrice}@${t.bidSize} ask=${t.askPrice}@${t.askSize}`);
    }

    const side = pickSide(cfg);
    const quantity = String(notional);
    const cidBase = `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

    log(`symbol=${sym.symbol} side=${side} qty=${quantity}`);

    // 1) 开仓
    let openResp;
    try {
        openResp = await client.createOrder({
            orderType: "market",
            symbol: sym.symbol,
            side,
            quantity,
            timeInForce: "IOC",
            clientOrderId: cidBase,
        });
    } catch (e) {
        return { ok: false, error: `open: ${formatErr(e)}` };
    }

    const openTrade = openResp.trades?.[0];
    if (!openTrade) {
        return { ok: false, error: `open: no trade in resp: ${JSON.stringify(openResp).slice(0, 200)}` };
    }
    log(`open  fill price=${openTrade.price} fee=${openTrade.tradingFees} orderId=${openTrade.orderId}`);

    // 2) 极短间隔避免 race (可调)
    if (cfg.gapMs > 0) await sleep(cfg.gapMs);

    // 3) 平仓 (close-position flag, 不带 side)
    let closeResp;
    try {
        closeResp = await client.createOrder({
            orderType: "market",
            symbol: sym.symbol,
            timeInForce: "IOC",
            flags: ["close-position"],
            clientOrderId: cidBase + "c",
        });
    } catch (e) {
        return {
            ok: false,
            error: `close: ${formatErr(e)} (open 已成交, 注意手动平仓!)`,
            open: tradeRecord(openTrade),
        };
    }
    const closeTrade = closeResp.trades?.[0];
    if (!closeTrade) {
        return {
            ok: false,
            error: `close: no trade in resp; positions 可能未归零`,
            open: tradeRecord(openTrade),
        };
    }
    log(`close fill price=${closeTrade.price} fee=${closeTrade.tradingFees} orderId=${closeTrade.orderId}`);

    // 4) 校验 positions 归零 (可选)
    let positionsClean = null;
    if (cfg.verifyClose) {
        await sleep(cfg.verifyDelayMs ?? 1000);
        try {
            const pos = (await client.getPositions()).positions ?? [];
            const stillOpen = pos.find(p =>
                p.symbol === sym.symbol && parseFloat(p.notional) !== 0
            );
            positionsClean = !stillOpen;
            if (stillOpen) {
                log(`!! 校验失败: ${sym.symbol} 仓位未归零, notional=${stillOpen.notional}`);
            }
        } catch (e) {
            log(`校验持仓 err: ${formatErr(e)}`);
        }
    }

    return {
        ok: true,
        symbol: sym.symbol,
        underlying: sym.underlyingAsset,
        maturity: sym.maturityDate,
        open: tradeRecord(openTrade),
        close: tradeRecord(closeTrade),
        positionsClean,
        pnl: estimatePnl(openTrade, closeTrade, side),
    };
}

function tradeRecord(t) {
    return {
        side: t.side,
        price: t.price,
        volume: t.volume,
        fee: t.tradingFees,
        time: t.time,
        orderId: t.orderId,
    };
}

// 简易估算: (closePrice - openPrice) × volume × ±1, 不含 funding 浮动
function estimatePnl(open, close, openSide) {
    const dir = openSide === "buy" ? 1 : -1;
    const pnl = (parseFloat(close.price) - parseFloat(open.price)) * parseFloat(open.volume) * dir;
    const fees = parseFloat(open.tradingFees) + parseFloat(close.tradingFees);
    return { gross: pnl.toFixed(4), fees: fees.toFixed(4), net: (pnl + fees).toFixed(4) };
}

function formatErr(e) {
    if (e.response) return `${e.response.status} ${JSON.stringify(e.response.data)}`;
    return e.message;
}
