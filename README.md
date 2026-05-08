# rho-trade

Rho-X 协议 ([rho.trading](https://x.rho.trading/)) 多钱包自动化交易框架：链上入金 → 协议侧策略 → 守护进程定时跑。

## 功能概览

| 模块 | 说明 |
|---|---|
| **钱包管理** | 一键生成 N 个 EVM 钱包；按列名识别敏感列加密（AES-256-CBC + scrypt）；每钱包绑定独立 HTTP 代理 |
| **链上入金** | LiFi swap（ETH→USDT）+ Router.deposit 一条龙；Phase 0 强制 Rho 协议侧激活避免 indexer 漏 event；按钱包独立 Provider 走 Infura RPC pool |
| **交易策略** | 策略 1 秒开秒关（多市场随机 + 周内 ≥3 不同市场强制覆盖）；策略 2 配平（2-7 钱包同 symbol 对冲） |
| **Daemon** | `manage.sh` 控制后台守护进程，每天 09:00+jitter 自动触发；优雅停机；状态文件幂等 |
| **可观测** | 状态持久化 `state.json`；钱包级 `verify.mjs` 工具查协议侧/链上 |

## 安装

```bash
git clone https://github.com/someonelikeyoujiyue/test-5.8.git rho-trade
cd rho-trade
npm install

# 环境变量
cp .env.example .env
# 编辑 .env, 填 RHO_PASSWORD 和 INFURA_KEYS (可选)

# 钱包准备
cp wallets.csv.example wallets.csv
# 编辑 wallets.csv 加入你的钱包 (Address, privateKey, Mnemonic, proxyHost..)
# 或: node generate-wallets.mjs 1000  生成 1000 个新钱包
# 然后给每个钱包绑定代理 (Webshare 格式)
node assign-proxies.mjs your-proxies.txt

# 加密敏感列 (privateKey, Mnemonic)
node encrypt.mjs
```

## 文件结构

```
rho-trade/
├── trade.mjs                 主入口 (daemon + 一次性)
├── deposit.mjs               入金管线 (swap + deposit)
├── verify.mjs                钱包状态检查
├── encrypt.mjs / decrypt.mjs 钱包加解密
├── generate-wallets.mjs      生成 N 个 EVM 钱包
├── manage.sh                 daemon 管理脚本
├── config.mjs                所有配置
├── lib/
│   ├── cipher.mjs            askPassword + AES + scrypt
│   ├── rho.mjs               RhoClient (Bearer + 6 步登录 + 重试)
│   ├── deposit.mjs           RhoDeposit (Router.deposit on L1)
│   ├── swap.mjs              LiFiSwap (ETH→USDT)
│   ├── rpc.mjs               buildProvider + sticky pool
│   ├── state.mjs             state.json 读写 + dayKey
│   └── scheduler.mjs         daemon 调度器
├── strategies/
│   ├── instant.mjs           策略 1 秒开秒关
│   └── balance.mjs           策略 2 配平
├── wallets.csv.example       钱包 CSV 模板
├── .env.example              环境变量模板
└── NOTES.md                  详细技术备忘 + 协议踩坑记录
```

## 常用命令

### 一次性手动跑

```bash
# 入金 (有 selector 自动 one-shot)
node deposit.mjs 1                  # 钱包 1
node deposit.mjs 1-10               # 1-10
node deposit.mjs 3 --amount=10      # 单笔上限 10 USDT (测试用)

# 策略
node trade.mjs instant 1-10         # 跑策略并退出
node trade.mjs balance 1-10         # 配平策略

# 状态查询
node verify.mjs 1-10                # 查链上 + 协议侧
node decrypt.mjs 1                  # 看明文私钥+助记词
```

### 长期 daemon

```bash
./manage.sh start instant           # 后台启动 (策略 = instant)
./manage.sh status                  # 看 pid + state + 日志
./manage.sh tail                    # 实时跟日志
./manage.sh stop                    # 优雅停 (等当前 cycle 收尾)
./manage.sh restart instant
```

## 配置（`config.mjs`）

| 字段 | 说明 |
|---|---|
| `concurrency` | 钱包并发 |
| `dayBoundary` | 日切边界（local / UTC / IANA TZ） |
| `schedule.hourLocal/.minuteLocal/.jitterMinutes` | daemon 每日触发时刻 |
| `instant.notionalUsdRange` | 单笔名义额随机区间 (默认 100-1000 USDT) |
| `instant.symbolPrefixes` | 候选 prefix UNION (默认 5 个交易所) |
| `instant.minDistinctMarketsPerWeek` | 一周内强制至少 N 个不同市场 (默认 3) |
| `swap.minEthToSwap / leaveEthForGas / slippage` | swap 触发条件、储备、滑点 |
| `deposit.amountUsdt` | deposit 最小阈值（实际存全部余额） |
| `deposit.ethRpcUrls` | 来自 `INFURA_KEYS` env (逗号分隔多个 key) |

## .env 配置

```env
RHO_PASSWORD=your-wallet-decryption-password
INFURA_KEYS=key1,key2,key3,...   # 可选, 不填用 publicnode 兜底
```

## 重要约定

1. **永远先 login 后 deposit**：Rho indexer 不会回扫历史 event，deposit 之前 user 必须已激活（deposit.mjs 已自动处理 Phase 0）
2. **永远幂等**：deposit / trade 重跑都基于当前链上+协议状态判断，不会重复消费成功的钱包
3. **多样性目标**：策略 1 自动追踪每钱包过去 7 天的市场，前 3 天强制选不同 market
4. **风险隔离**：测试新钱包用 `--amount=10` 上限，避免一笔丢失全部资金

详细协议细节、合约地址、踩坑记录见 [NOTES.md](./NOTES.md)。

## 安全

- `.env`、`wallets.csv`、`.salt`、`state.json`、`logs/`、抓包 dump、代理凭据等敏感文件全部在 `.gitignore` 里
- 钱包 CSV 的 `privateKey` 和 `Mnemonic` 列加密；`proxy*` 列保持明文（敏感度较低）
- 启动时密码可通过 `RHO_PASSWORD` env 注入，避免交互式输入

## License

私有项目，未授权请勿使用。
