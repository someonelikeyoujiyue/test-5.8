// Rho-X 自动交易配置
// 敏感字段 (Infura keys, 解密密码) 走 .env (gitignore 挡住), 模板见 .env.example
import "dotenv/config";

export const config = {
    // REST API base
    apiBase: "https://api.x.rho.trading",

    // 选用哪个策略 (见 strategies/index.mjs): "instant" | "balance"
    strategy: "instant",

    // 启动时清理任何未平仓的孤儿仓位 (实现"今天之内没有平仓的需要平仓")
    cleanupOnStart: true,

    // 钱包并发
    concurrency: 10,

    // 失败钱包是否重试 (重跑脚本时, 失败记录默认会重试; ok 会跳过)
    retryFailed: true,

    // 状态文件 (相对项目根)
    stateFile: "state.json",

    // 日切边界: "local" | "UTC" | IANA TZ (例 "Asia/Shanghai")
    // 每个钱包每天执行一次, 这里决定"一天"怎么算
    dayBoundary: "local",

    // ---- 守护进程调度 ----
    // 启动若今日尚未全部完成 -> 立即补跑一次
    // 之后每天 hourLocal:minuteLocal (本地时区) + 0..jitterMinutes 随机
    schedule: {
        hourLocal: 9,
        minuteLocal: 0,
        jitterMinutes: 30,
        pollIntervalSeconds: 60,   // shutdown 响应粒度
    },

    // 是否使用每钱包绑定的代理 (来自 wallets.csv 的 proxyHost/Port/Username/Password 列)
    // 没填代理的钱包则不走代理
    useProxy: true,

    // dryRun 总开关 - 策略可读取
    dryRun: false,

    // ---- 策略 1: 秒开秒关 ----
    instant: {
        // 候选 prefix (UNION 模式, 任一前缀命中即纳入候选池)
        // 注意: "RHO-" 只有 RHO-BTCUSDT / RHO-ETHUSDT 共 2 个 market,
        // 不够 minDistinctMarketsPerWeek=3, 必须扩到其他交易所前缀.
        symbolPrefixes: ["RHO-", "BINANCE-", "OKX-", "BYBIT-", "ASTER-"],

        // 接受的标的资产
        underlyings: ["BTC", "ETH"],

        // 单笔名义额 (USDT, 直接 = 下单 quantity)
        // 区间随机: [min, max] 整数 USDT; 单值用 [N, N] 写
        // symbol 的 minTradeNotional 通常 100, 下限不能低于 100
        notionalUsdRange: [100, 1000],

        // 方向: random | long | short
        side: "random",

        // 开/平之间的间隔 (毫秒); 0 表示立即
        gapMs: 200,

        // 平仓后是否查 positions 校验归零
        verifyClose: true,
        verifyDelayMs: 1500,

        // 多样性约束: 一周内每钱包至少交易 N 个不同 market (项目方任务要求 = 3)
        // 当 lookback 内已交易 market 数 < minDistinctMarketsPerWeek,
        // 强制从未交易过的候选池挑选; 满足后回归纯随机
        minDistinctMarketsPerWeek: 3,
        lookbackDays: 7,

        // 秒开秒关 spread + 流动性约束 (避免吃多档滑点)
        // spread 单位是利率 (rate), 0.01 = 1% 价差
        maxSpread: 0.01,
        // bidSize 和 askSize 都需 ≥ notional × multiplier
        // 1.0 = 刚好够; 1.5 = 留 50% 安全垫 (避免吃完 top of book)
        minLiquidityMultiplier: 1.5,
    },

    // ---- 策略 2: 配平 (balance / wash) ----
    // 随机 N 个钱包一组, 同 symbol 上 kLong 买 + kShort 卖, 两边 notional 相等
    balance: {
        symbolPrefixes: ["RHO-"],
        underlyings: ["BTC", "ETH"],

        // 组规模随机 [min, max] 钱包
        minWallets: 2,
        maxWallets: 7,

        // 单元名义额; 实际每钱包下的 notional = unit * (该侧的对手数)
        // 例: kL=2, kS=3 -> 长方每个 $300, 短方每个 $200, 两边总和都是 $600
        // 注意 unit*(maxWallets-1) 不能低于 minTradeNotional (100)
        unitNotional: 100,

        // 持仓时长 (秒) 随机区间; [0,0] 为秒开秒关
        holdSecondsRange: [0, 2],
    },

    // ---- ETH -> USDT swap (LiFi via integrator=RhoX) ----
    // 在 deposit pipeline 里, 钱包 ETH >= minEthToSwap 时先 swap 大部分 ETH 到 USDT
    // 再走 approve + deposit, 留 leaveEthForGas 作为 gas 储备
    swap: {
        enabled: true,
        integrator: "RhoX",
        slippage: 0.01,                   // 1% 滑点 (0.5% 在并发时偶发 revert)

        // 钱包 ETH < 此值 → 跳过 swap (人类单位 ETH)
        minEthToSwap: "0.009",

        // swap 后留多少 ETH 给 gas (人类单位 ETH)
        leaveEthForGas: "0.0015",

        // swap tx 上链后, 等多久再查 USDT 余额 (毫秒)
        waitAfterSwapMs: 3000,
    },

    // ---- 链上入金 (funding 市场, Ethereum 主网) ----
    deposit: {
        // 主 RPC 池: 按钱包地址 hash sticky 选一个, 1000 钱包均匀分到 N 个 RPC key
        // **不要在这里硬编码 API key**, 用 .env (gitignore 已挡):
        //     INFURA_KEYS=key1,key2,key3,...
        // 兜底单 URL 用 publicnode 公共节点
        ethRpcUrls: process.env.INFURA_KEYS
            ? process.env.INFURA_KEYS.split(",").map(k => `https://mainnet.infura.io/v3/${k.trim()}`)
            : null,
        ethRpcUrl: "https://ethereum-rpc.publicnode.com",
        // RPC 是否走每钱包代理. 默认 false:
        //   - Webshare HTTP proxy 跟 Infura 不兼容 (ECONNRESET)
        //   - sendTransaction 的 from 已链上公开, IP 隐私无意义
        //   - LiFi/Rho REST 仍走代理, RPC 直连 Infura 就行
        rpcUseProxy: false,
        gateway: "0x461ffa24b716f68c5a4fb583592f295db5f7ba36",
        usdt: "0xdac17f958d2ee523a2206206994597c13d831ec7",
        marketId: "0xf004fc6ea02a304b9cbbcde3610a3cda0aa9597cfd77f6073c24138bc99c073e",
        tag: '["funding"]',
        // 触发 deposit 的最小 USDT 阈值 (人类单位).
        // 实际存入 = 钱包当前 USDT 余额全部 (不是这里的固定数量).
        // 余额 < 此值 → 跳过 deposit.
        amountUsdt: 10,
        minEthForGas: "0.0003",
        deadlineSeconds: 600,
        concurrency: 5,
        dryRun: false,
    },
};
