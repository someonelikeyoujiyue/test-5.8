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
    const cidBase = `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const minNotional = parseFloat(sym.minTradeNotional) || 100;
    const openMaxAttempts = cfg.openMaxAttempts ?? 5;
    const closeMaxAttempts = cfg.closeMaxAttempts ?? cfg.maxClosePasses ?? 5;
    const retryGapMs = cfg.retryGapMs ?? 500;
    const openMinFillRatio = cfg.openMinFillRatio ?? 0.99;

    log(`symbol=${sym.symbol} side=${side} target_notional=${notional}`);

    // 1) 开仓: 多次 IOC 凑齐 notional (不能 partial 锁仓, 也不能多开)
    const openR = await fillIoc(client, sym.symbol, side, notional, {
        maxAttempts: openMaxAttempts, retryGapMs, minNotional,
    }, log, cidBase + "o");

    const openVol = openR.totalVol;
    if (openVol < notional * openMinFillRatio) {
        // 凑不齐: 把已 partial 的反向平回, 不留 orphan
        log(`!! 开仓凑齐失败 (累计 ${openVol.toFixed(2)} < ${(notional * openMinFillRatio).toFixed(2)})`);
        if (openVol > 0) {
            log(`   反向平回已开 vol=${openVol.toFixed(4)}`);
            const rb = await fillIoc(client, sym.symbol, side === "buy" ? "sell" : "buy", openVol, {
                maxAttempts: closeMaxAttempts, retryGapMs, minNotional,
            }, log, cidBase + "rb");
            const rbResidual = openVol - rb.totalVol;
            if (rbResidual >= 0.01 && (cfg.closePositionFallback ?? true)) {
                await closePositionFallback(client, sym.symbol, log, (cidBase + "rcp").slice(0, 36));
            }
        }
        return { ok: false, error: `open 凑不齐 (${openVol.toFixed(2)}/${notional}), 已平回` };
    }
    log(`open  ✓ vol=${openVol.toFixed(2)} (${openR.fills.length} fills, fee=${openR.totalFee.toFixed(4)})`);

    // 2) 持仓: holdMsRange [min, max] 随机; 兼容旧 gapMs 单值
    const [holdMin, holdMax] = cfg.holdMsRange ?? [cfg.gapMs ?? 200, cfg.gapMs ?? 200];
    const holdMs = Math.floor(holdMin + Math.random() * Math.max(0, holdMax - holdMin));
    if (holdMs > 0) await sleep(holdMs);

    // 3) 平仓: 反向 IOC 凑齐 openVol, 残量 < minNotional 时 close-position 兜底
    const closeSide = side === "buy" ? "sell" : "buy";
    const closeR = await fillIoc(client, sym.symbol, closeSide, openVol, {
        maxAttempts: closeMaxAttempts, retryGapMs, minNotional,
    }, log, cidBase + "c");

    let totalClosed = closeR.totalVol;
    let totalCloseFee = closeR.totalFee;
    let closeFills = closeR.fills.map(tradeRecord);
    let lastClose = closeR.lastTrade;
    let residual = openVol - totalClosed;

    // close-position 兜底: 残 < minNotional 时普通 IOC 单 400, 但 flags=["close-position"] 服务端绕开检查
    // 代价: 多 1 笔 fee (~$0.05), 收益: 不锁仓 = daily vol 稳, cleanup 也不用扫这单
    if (residual >= 0.01 && (cfg.closePositionFallback ?? true)) {
        log(`  残 ${residual.toFixed(4)}, close-position 兜底 (额外 1 笔 fee)`);
        const cpTrade = await closePositionFallback(client, sym.symbol, log, (cidBase + "cp").slice(0, 36));
        if (cpTrade) {
            totalClosed += parseFloat(cpTrade.volume);
            totalCloseFee += parseFloat(cpTrade.tradingFees) || 0;
            lastClose = cpTrade;
            closeFills.push(tradeRecord(cpTrade));
        }
        residual = openVol - totalClosed;
    }

    const positionsClean = Math.abs(residual) < 0.01;
    if (!positionsClean) log(`!! 仍残 vol=${residual.toFixed(4)}`);
    if (!lastClose) {
        return { ok: false, error: `close: 0 次成交 (open vol=${openVol.toFixed(2)} 全部锁仓)` };
    }

    return {
        ok: positionsClean,
        symbol: sym.symbol,
        underlying: sym.underlyingAsset,
        maturity: sym.maturityDate,
        open: openSummary(openR, side),
        close: tradeRecord(lastClose),
        closeFills: closeFills.length > 1 ? closeFills : undefined,
        positionsClean,
        residual: residual.toFixed(4),
        totalClosed: totalClosed.toFixed(4),
        pnl: estimatePnlSmart(openR, lastClose, side, totalClosed, totalCloseFee),
    };
}

// 多次 IOC 凑齐 target vol (open 凑齐 notional / close 平干净都用)
// 中间 sleep retryGapMs 让 LP 补单; 残量 < minNotional 时停止 (服务端会拒)
async function fillIoc(client, symbol, side, target, opts, log, cidPrefix) {
    const { maxAttempts = 5, retryGapMs = 500, minNotional = 100 } = opts;
    const fills = [];
    let totalVol = 0;
    let totalFee = 0;
    let lastTrade = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const remainingRaw = target - totalVol;
        const remaining = Math.floor(remainingRaw * 1e6) / 1e6;
        if (remaining < minNotional) break;
        const cid = `${cidPrefix}${attempt > 1 ? attempt : ""}`.slice(0, 36);
        let resp;
        try {
            resp = await client.createOrder({
                orderType: "market", symbol, side,
                quantity: remaining.toFixed(6),
                timeInForce: "IOC", clientOrderId: cid,
            });
        } catch (e) {
            log(`  ${cidPrefix} #${attempt} 异常: ${formatErr(e)}`);
            return { fills, totalVol, totalFee, lastTrade, error: e };
        }
        const tr = resp.trades?.[0];
        if (!tr) {
            log(`  ${cidPrefix} #${attempt}: 0 成交${attempt < maxAttempts ? `, 等 ${retryGapMs}ms` : ""}`);
            if (attempt < maxAttempts) await sleep(retryGapMs);
            continue;
        }
        const v = parseFloat(tr.volume);
        totalVol += v;
        totalFee += parseFloat(tr.tradingFees) || 0;
        lastTrade = tr;
        fills.push(tr);
        log(`  ${cidPrefix} #${attempt}: px=${tr.price} vol=${v} fee=${tr.tradingFees}${totalVol < target - 0.01 ? ` (${totalVol.toFixed(2)}/${target})` : ""}`);
        if (totalVol >= target - 0.01) break;
        if (attempt < maxAttempts) await sleep(retryGapMs);
    }
    return { fills, totalVol, totalFee, lastTrade };
}

// close-position flag: 服务端按当前持仓自动反向平 (绕开 minNotional 检查)
// cleanupOnStart=true 保证开仓前 0 持仓, 所以这里只会平掉刚开未平干净的部分
async function closePositionFallback(client, symbol, log, cid) {
    try {
        const resp = await client.createOrder({
            orderType: "market", symbol, timeInForce: "IOC",
            flags: ["close-position"], clientOrderId: cid,
        });
        const tr = resp.trades?.[0];
        if (tr) {
            log(`  close-position ✓ px=${tr.price} vol=${tr.volume} fee=${tr.tradingFees}`);
            return tr;
        }
        log(`  close-position: 0 成交 (持仓可能已被别处平)`);
        return null;
    } catch (e) {
        log(`  close-position 失败: ${formatErr(e)}`);
        return null;
    }
}

function openSummary(openR, side) {
    if (!openR.fills.length) return null;
    const totalCost = openR.fills.reduce((s, t) => s + parseFloat(t.price) * parseFloat(t.volume), 0);
    const avgPx = totalCost / openR.totalVol;
    return {
        side, avgPrice: avgPx.toFixed(8),
        volume: openR.totalVol.toFixed(4),
        fee: openR.totalFee.toFixed(6),
        fills: openR.fills.length,
        firstOrderId: openR.fills[0]?.orderId,
        time: openR.fills[0]?.time,
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

// 智能版 pnl: open 多笔 fill 加权平均价 vs 最后 close price 近似
function estimatePnlSmart(openR, lastClose, side, totalClosed, totalCloseFee) {
    const dir = side === "buy" ? 1 : -1;
    const totalCost = openR.fills.reduce((s, t) => s + parseFloat(t.price) * parseFloat(t.volume), 0);
    const avgOpenPx = openR.totalVol > 0 ? totalCost / openR.totalVol : 0;
    const closePx = parseFloat(lastClose.price);
    const gross = (closePx - avgOpenPx) * totalClosed * dir;
    const fees = openR.totalFee + totalCloseFee;
    return { gross: gross.toFixed(4), fees: fees.toFixed(4), net: (gross + fees).toFixed(4) };
}

function formatErr(e) {
    if (e.response) return `${e.response.status} ${JSON.stringify(e.response.data)}`;
    return e.message;
}
