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

// distinct key: 按 market 名 (不含 maturity), 跟项目方 market_explorer.qualifying_markets 一致
// 项目方算法: RHO-BTCUSDT:29MAY26 和 RHO-BTCUSDT:26JUN26 算同一个 market (RHO-BTCUSDT)
// 不能改成 full symbol, 否则策略会在同一 market 的不同 maturity 间转, distinct 虚高但项目方只算 1 个
const symbolToMarket = s => s ? s.split(":")[0] : s;

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
// (适配 v2 array 格式, 兼容 v1 single-record)
function tradedMarkets({ state, address, today, lookback, boundary, strategyName }) {
    if (!state || !address || !today) return new Set();
    const markets = new Set();
    for (const day of pastDayKeys(today, lookback, boundary)) {
        for (const r of getDayRuns(state, address, day, strategyName)) {
            if (r?.status === "ok" && r.symbol) {
                markets.add(symbolToMarket(r.symbol));
            }
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
    // todayMs 装的是 market 名 (不含 maturity), candidate 用 symbolToMarket 转换匹配
    if (avoidSameMarketSameDay && todayMs && todayMs.size > 0) {
        const fresh = candidates.filter(s => !todayMs.has(symbolToMarket(s.symbol)));
        if (fresh.length > 0) candidates = fresh;
        // else: 今日所有 market 都跑过了, 允许重复 maturity
    }

    // 多样性: 一周内已交易 market 数 < minDistinct → 优先未交易过的 market
    const tradedCount = traded?.size ?? 0;
    if (traded && minDistinct > 0 && tradedCount < minDistinct) {
        const untraded = candidates.filter(s => !traded.has(symbolToMarket(s.symbol)));
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
    const openVol = parseFloat(openTrade.volume);
    log(`open  fill price=${openTrade.price} vol=${openVol} fee=${openTrade.tradingFees} orderId=${openTrade.orderId}`);

    // 2) 极短间隔避免 race (可调)
    if (cfg.gapMs > 0) await sleep(cfg.gapMs);

    // 3) 平仓: 反向 side + 与 open 完全等量 (不用 close-position flag)
    //    这样只平掉刚开的这一笔, 不会动到该钱包此前可能的遗留持仓.
    //    若 close 部分成交, 重试最多 maxClosePasses 次直到 totalClosed >= openVol.
    const closeSide = side === "buy" ? "sell" : "buy";
    const maxPasses = cfg.maxClosePasses ?? 3;
    const minNotional = parseFloat(sym.minTradeNotional) || 100;
    let totalClosed = 0;
    let lastClose = null;
    let totalCloseFee = 0;
    const closeFills = [];

    for (let pass = 1; pass <= maxPasses; pass++) {
        const remainingRaw = openVol - totalClosed;
        if (remainingRaw <= 0.01) break;   // 已经平完 (留 0.01 容差应付浮点)
        // 浮点减法会引入精度误差 (76.04 - 23.96 = 52.07999999999999), 服务端要求 6 位精度.
        // 向下截断到 6 位, 避免传 "76.03999999999996" 被拒.
        const remaining = Math.floor(remainingRaw * 1e6) / 1e6;
        if (remaining < minNotional) {
            // 残量低于 minTradeNotional, 再发单也是 400; 留给 cleanupOnStart 下次扫
            log(`  close pass${pass}: 残量 ${remaining.toFixed(4)} < minNotional ${minNotional}, 放弃重试`);
            break;
        }
        const closeCid = (cidBase + "c" + (pass > 1 ? pass : "")).slice(0, 36);
        let resp;
        try {
            resp = await client.createOrder({
                orderType: "market",
                symbol: sym.symbol,
                side: closeSide,
                quantity: remaining.toFixed(6),
                timeInForce: "IOC",
                clientOrderId: closeCid,
            });
        } catch (e) {
            return {
                ok: false,
                error: `close pass${pass}: ${formatErr(e)} (open 已成交 vol=${openVol}, 残留 ${remaining.toFixed(4)})`,
                open: tradeRecord(openTrade),
            };
        }
        const tr = resp.trades?.[0];
        if (!tr) {
            // 没成交记录但 API 没报错; 可能盘口空了, 跳出循环
            log(`  close pass${pass}: 无成交 (返回 trades 空), 残留 ${remaining.toFixed(4)}`);
            break;
        }
        const v = parseFloat(tr.volume);
        totalClosed += v;
        totalCloseFee += parseFloat(tr.tradingFees) || 0;
        lastClose = tr;
        closeFills.push(tradeRecord(tr));
        log(`close ${pass>1?`(pass${pass})`:""} fill price=${tr.price} vol=${v} fee=${tr.tradingFees}${totalClosed < openVol ? ` (累计 ${totalClosed}/${openVol})` : ""}`);
        if (totalClosed >= openVol - 0.01) break;
        await sleep(300);   // 等 LP 补单
    }

    const residual = openVol - totalClosed;
    let positionsClean = Math.abs(residual) < 0.01;
    if (!positionsClean) {
        log(`!! 残留 vol=${residual.toFixed(4)} (open ${openVol}, 累计 close ${totalClosed.toFixed(4)}); ${maxPasses} 次重试仍未平完`);
    }

    if (!lastClose) {
        return {
            ok: false,
            error: `close: 0 次成交 (open vol=${openVol} 全部残留, 用 cleanup.mjs 扫)`,
            open: tradeRecord(openTrade),
        };
    }

    // close 字段记录最后一笔; closeFills 记录所有 pass (调试用)
    return {
        ok: positionsClean,    // 残留视为 fail (好让 trade.mjs 重试)
        symbol: sym.symbol,
        underlying: sym.underlyingAsset,
        maturity: sym.maturityDate,
        open: tradeRecord(openTrade),
        close: tradeRecord(lastClose),
        closeFills: closeFills.length > 1 ? closeFills : undefined,
        positionsClean,
        residual: residual.toFixed(4),
        totalClosed: totalClosed.toFixed(4),
        pnl: estimatePnlAcc(openTrade, lastClose, side, openVol, totalClosed, totalCloseFee),
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

// 多次 close pass 的累计 pnl (用最后 close price 近似, 更精确要按每 pass 加权)
function estimatePnlAcc(open, lastClose, openSide, openVol, totalClosed, totalCloseFee) {
    const dir = openSide === "buy" ? 1 : -1;
    const closePx = parseFloat(lastClose.price);
    const openPx = parseFloat(open.price);
    const gross = (closePx - openPx) * totalClosed * dir;
    const openFee = parseFloat(open.tradingFees) || 0;
    const fees = openFee + totalCloseFee;
    return { gross: gross.toFixed(4), fees: fees.toFixed(4), net: (gross + fees).toFixed(4) };
}

function formatErr(e) {
    if (e.response) return `${e.response.status} ${JSON.stringify(e.response.data)}`;
    return e.message;
}
