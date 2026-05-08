# rho-trade 知识库 & 待办

记录从 Rho-X 文档 + xStock 代码中梳理出的所有信息，方便下次接着干。

---

## 1. Rho-X 协议总览

- **性质**：interest rate derivatives DEX（funding rate / lending-borrowing rate / staking reward 的链上衍生品）
- **入金链**：**Ethereum Mainnet**（chainId 1）— 实测确认。文档老页提到 Arbitrum + Router `0xbEF0110...`，但当前用户走的是 L1 上的另一套 gateway，不要参考那段。
- **抵押品（funding 市场）**：USDT（6 decimals），地址 `0xdac17f958d2ee523a2206206994597c13d831ec7`
- **保证金**：
  - Initial Margin (IMC)：当前 7%/year，按 time-to-expiry 调整，开仓前必须有
  - Maintenance Margin (MMC)：当前 4%/year，低于则清算
- **资金托管**：链上合约（**不是** CEX 内部账本），入金需要 on-chain tx
- **官方文档根**：https://docs.rho.trading/

### 关键合约（Ethereum 主网，funding 市场）

| 合约 | 地址 |
|---|---|
| Deposit Gateway (proxy, EIP-1967) | `0x461ffa24b716f68c5a4fb583592f295db5f7ba36` |
| Gateway implementation | `0x6e1ea5943d43940f611b1282d8d3467f37cdcfce` |
| 内部 vault（USDT 最终去处） | `0x7094d8cb2b02a3899cae5af16e0cb00f8bcd1862` |
| USDT | `0xdac17f958d2ee523a2206206994597c13d831ec7` |

### 已知 marketId（funding 市场）

- `0xf004fc6ea02a304b9cbbcde3610a3cda0aa9597cfd77f6073c24138bc99c073e`
- 用户确认：所有要交易的 perp 都共用这一个 funding marketId，**只需对它入金一次**

---

## 2. Auth API

**Base**：`https://api.x.rho.trading/auth-api/v1`
**Swagger**：https://api.x.rho.trading/auth-api/v1/swagger/index.html

### 三种凭据
1. **Access Token (Bearer)** — base64 token，FullAccess scope，REST + 用来 mint WS token 的主流程
2. **API Key + HMAC Secret** — 长期凭据，scopes ReadOnly / FullAccess，请求需签名
3. **WebSocket Session Token** — 短生命周期，给 WS handshake 用

### 端点

| Method | Path | Body | Resp |
|---|---|---|---|
| POST | `/nonce` | `{address}` | `{issuedAt, messageToSign, nonce}` |
| POST | `/login` | `{address, signature, type, referralCode?}` | `{token}` |
| POST | `/logout` | `{token}` | empty (Auth: Bearer) |
| GET | `/apikeys` | – | `{apiKeys: [...]}` |
| POST | `/apikeys` | `{label, scopes, expiresAt?}` | `{id, key, secret}` |
| POST | `/apikeys/revoke` | `{id}` | empty |
| POST | `/ws-session` | – | `{wsSessionToken}` |
| PUT | `/ws-session` | `{wsSessionToken}` | empty |
| POST | `/ws-session/revoke` | `{wsSessionToken}` | empty |

### 登录流程（Bearer 模式）

```
nonce → personal_sign(messageToSign) → /login {address, signature, type:"evm"} → token
```

### HMAC 签名（API Key 模式）

```
payload    = METHOD + "\n" + PATH + "\n" + QUERY + "\n" + HEADER + "\n" + BODY_HASH
BODY_HASH  = hex(SHA256(body))
HEADER     = 所有 Rho* 头（除 RhoSignature），名小写，按字母排序，用 & 拼
signature  = hex(HMAC_SHA256(secret, payload))
```

请求必带头：
- `RhoKey: <api key>`
- `RhoExpiration: <RFC-3339 UTC>`
- `RhoSignature: <hex>`

---

## 3. REST API

**Base**：`https://api.x.rho.trading/api/v1`

### 行情（无需鉴权）
| Method | Path | 说明 |
|---|---|---|
| GET | `/exchange/info` | 列 symbols / currencies / markets metadata |
| GET | `/tickers` | 全部 ticker |
| GET | `/tickers/{symbol}` | 单个 ticker |
| GET | `/symbols/{symbol}/order-book` | 订单簿 |
| GET | `/symbols/{symbol}/trades` | 成交流水 |
| GET | `/symbols/{symbol}/candles` | K 线 |
| GET | `/markets/{marketId}/floating-rate-candles` | 浮动利率 K 线 |

### 账户（Bearer）
| Method | Path | 说明 |
|---|---|---|
| GET | `/margin-accounts` | 列保证金账户 |
| GET | `/margin-accounts/{id}` | 单账户 |
| GET | `/users/balances?marginAccount=...` | 余额（按 margin account） |
| GET | `/users/balances/withdrawable?marginAccount=...` | 可提现余额 |
| GET | `/users/positions?marginAccount=...` | 持仓 |
| GET | `/users/transfers` | 入出金记录（含 `transferType: deposit`）|
| POST | `/users/withdrawals` | 提现（body schema 待确认）|

### 订单（Bearer）
| Method | Path | 说明 |
|---|---|---|
| POST | `/orders` | 创建订单 |
| POST | `/orders/cancel` | 撤一单 (`orderId` 或 `clientOrderId`) |
| POST | `/orders/cancel-all` | 批量撤单（可选 `symbol` / `marginAccount` / `side`）|

### POST /orders body schema (`dto.RestCreateOrderRequest`)

| 字段 | 类型 | 必需 | 取值 |
|---|---|---|---|
| `orderType` | string | ✓ | `"limit"` / `"market"` |
| `symbol` | string | ✓ | – |
| `side` | string | – | `"buy"` / `"sell"` |
| `quantity` | string | – | – |
| `price` | string | – | – |
| `timeInForce` | string | – | `"GTC"` / `"IOC"` |
| `clientOrderId` | string | – | max 36 字符 |
| `flags` | string[] | – | `["close-position"]` |

**注意**：`leverage` 和 `marginAccount` **不在 body 里**。杠杆需在 margin-account 侧设置（REST 文档没暴露 set-leverage 端点，目前要走 UI）。

### ⚠️ 实测踩到的坑（2026-05-07）
- **`flags:["close-position"]` 单不能带 `side`**，否则 400 `"Order side should be empty for market order with ClosePosition flag"`。close-position 单只填 `orderType / symbol / timeInForce / flags / clientOrderId`，服务端按现有仓位自动反向。
- **quantity = notional USDT**（不是合约张数也不是 BTC 数量）。直接传 `quantity:"100"` 就是 $100 名义额。
- **每个 symbol 有 `minTradeNotional`**（实测 RHO/BINANCE 都是 100）。低于会被拒。
- **symbol 命名**：`<EXCHANGE>-<PAIR>:<MATURITY>`，如 `RHO-BTCUSDT:29MAY26`，是 funding-rate-futures 而非永续。每个 symbol 有到期日，注意 `maturityLockUpWindow`（实测 1h，到期前 1h 不能开仓）。
- **ticker 返回包了一层**：`{ ticker: { lastPrice, markPrice, bidPrice, bidSize, askPrice, askSize, ... } }`。RhoClient.getTicker() 拿到的是外层对象，要 `.ticker` 才是真的 ticker。
- **ticker 价格是利率（rate）不是 USD**：例如 `lastPrice: -0.0118` 表示 -1.18% 利率。"卖空" = 押 funding rate 下跌，跟 BTC 现货价无关。
- **clientOrderId** 实测 14-16 字符 OK。`-` 也可以。max 36。

### REST API 没有 deposit 端点
文档原文：*"I cannot find a REST create deposit endpoint"*。**入金纯链上**（见第 5 节）。

---

## 4. WebSocket API

**URL**：`wss://stream.x.rho.trading/ws-api/v1`

### Auth handshake
先调 `POST /auth-api/v1/ws-session` 拿 token，然后发：
```json
{ "type":"authenticate", "params":{ "wsSessionToken":"<token>" } }
```
服务端回 `connection-acknowledge` + `connectionId`。

### 频道（已知名字）
- `user_positions` — 持仓流
- `user_balances` — 余额流
- 其他（market data: order book / tickers / trades / candles；user data: orders / trades / allocations）— 频道精确名字待抓接口

---

## 5. 链上入金（Ethereum L1 Gateway，funding 市场）

### 用户实测的两笔参考 tx
- approve: `0xf131331da7110e2ce44bf090dc70b9f61c111e31a93873eaabab26e4412ffcb3`
- deposit: `0xa56c34e3d99f4236027d4a082eec5bca35f6affca570c29e34673eb4e23e36db`

### 流程
```
1. IERC20(USDT).approve(GATEWAY, max_uint256)        // 一次即永久 (approve 选择器 0x095ea7b3)
2. GATEWAY.deposit(marketId, amount, USDT, recipient, tag, deadline)   // 选择器 0xba2ba716
```

### deposit 函数（按 calldata 反推）
```
selector: 0xba2ba716
params (按位置编码):
  bytes32  marketId       = 0xf004fc6ea02a304b9cbbcde3610a3cda0aa9597cfd77f6073c24138bc99c073e (funding)
  uint256  amount         = USDT 原始单位 (6 decimals → 1 USDT = 1_000_000)
  address  token          = USDT (0xdac17f...1ec7)
  address  recipient      = 自己钱包地址 (cross-margin owner)
  bytes    tag            = ASCII '["funding"]' (utf8 11 字节)
  uint256  deadline       = unix ts，建议 now + 600s
```

ethers v6 编码：
```js
const iface = new ethers.Interface([
  "function deposit(bytes32 marketId, uint256 amount, address token, address recipient, bytes tag, uint256 deadline)"
]);
const data = iface.encodeFunctionData("deposit",
  [marketId, amount, USDT, wallet.address, ethers.toUtf8Bytes('["funding"]'), deadline]);
```

### 关键事件（receipt logs，便于确认成交）
- topic0 `0x84281f5a50289cd0fc9ef270e5b6e262089de28295069ef83b86a64b2c18ab19` — gateway 自身的 `Deposit` 事件
  - topic1 = marketId
  - topic2 = token (USDT)
  - topic3 = recipient
- USDT Transfer：钱包 → gateway → vault `0x7094d8cb...1862`

---

## 6. xStock 加解密结构（已在 rho-trade 复用）

- `.salt`：16 字节随机 salt，hex 编码存盘
- KDF：`scryptSync(password, salt, 32)` → AES-256 key
- 字段格式：`<iv_hex>:<cipher_hex>`，**AES-256-CBC**，每字段独立 16B 随机 IV
- 启动期 `askPassword`：raw stdin、不回显、处理 Ctrl+C (0x03) / Ctrl+D (0x04) / DEL (0x7F) / 退格
- CSV 头明文，第二列起按字段加密
- `encrypt.mjs` 写盘前自检：解密第一条与原文比对一致才落盘
- `decrypt.mjs` 提供 `[N | N-M]` 范围参数

---

## 7. 当前框架结构（`/Users/fengxiaoji/code/rho-trade/`）

```
rho-trade/
├── package.json            ethers ^6 / axios / https-proxy-agent
├── .gitignore              忽略 .salt / wallets.csv / ip.txt / node_modules
├── config.mjs              symbols / notionalUsd / 持仓时长 / 并发 / dryRun
├── encrypt.mjs             加密 wallets.csv 的 privateKey 列
├── decrypt.mjs             范围解密查看
├── trade.mjs               主入口：解密 → 并发池 → 每钱包多轮：随机 symbol+方向 → 取价 → 开仓 → sleep → 平仓
├── lib/
│   ├── cipher.mjs          askPassword + scrypt + AES + loadWallets()
│   └── rho.mjs             RhoClient（Bearer 模式，登录/取价/下单/平仓）
├── wallets.csv.example     CSV 模板：Address,privateKey
├── README.md               用户手册
└── NOTES.md                本文件
```

### 已实现
- xStock 风格密码 + scrypt + AES-256-CBC 钱包加密、解密、CSV 装载
- Rho 钱包签名登录拿 Bearer token（ethers v6 `Wallet.signMessage`）
- 行情：`getTicker(symbol)`
- 下单：`createOrder` / `openMarket` / `closeMarket`（market + IOC + 平仓 flag）
- 撤单：`cancelOrder` / `cancelAll`
- 查持仓 / margin-account
- 多钱包并发池 + 每钱包多轮 + 随机持仓时长 + 随机轮间隔
- `dryRun` 默认开，确认 payload 再实盘
- 可选代理（`ip.txt`，`config.useProxy`）

### 已知缺陷
- 平仓靠固定 sleep（hold time），没用 WebSocket 等真实成交回报
- API Key + HMAC 模式没实现，目前 Bearer token 过期要重登
- 链上入金已实现（funding 市场 USDT），但杠杆 / 提现没做
- 失败只单层 try-catch，没退避策略
- `minTradeNotional` 没动态从 `/exchange/info` 读，`config.notionalUsd < 100` 会被拒

### 救援渠道（2026-05-08）
- Discord: https://discord.gg/pmCMcQV35r （首选, 最快）
- 邮箱: support@rhoprotocol.com
- Twitter: https://twitter.com/Rho_xyz
- GitHub Org: https://github.com/orgs/RhoLabs (公开仓库不含合约源码)
- 文档: https://docs.rho.trading/troubleshooting/contact-support

### ⚠️ 实测 wallet 2 第一笔 25.86 USDT 丢失场景 (2026-05-08)
- 链上 tx 0x64f75c98c907d80b1d57f59cedd5e28885a586076506f54110b3c8609d9647b9 完美 confirm
- gateway emit Deposit event 正确 (recipient=wallet 2)
- USDT 已进 vault 0x7094d8cb...
- 但 Rho indexer 永远没看到 → /transfers 永远空 → funding 余额永远 0
- 根因: deposit 发生时 wallet 2 在 Rho 协议侧 **未登录过, custody account 不存在**.
  indexer 扫块时 recipient 在 user table 查不到 → 静默丢弃 event, 不会回扫
- 同钱包第二次手动 deposit (10 USDT, 已先在前端登录) → 正确到账
- 修复: deposit.mjs Phase 0 强制先 `RhoClient.login()`（含完整 6 步登录），
  保证发 deposit 时 custody 已建

### implementation 合约可疑函数 (反推自 PUSH4 + openchain)
- `0x17c59b24 transferOut(uint256, address)` — owner only, **可手动退款**
- `0x66a6a4bd addAsset(address, uint256)` / `0x4a5e42b1 removeAsset` — admin
- `0x8456cb59 pause` / `0x3f4ba83a unpause` / `0x5c975abb paused`
- `0xc4d66de8 initialize(address)` (proxy)
- `0x4f1ef286 upgradeToAndCall` / `0x52d1902d proxiableUUID` (UUPS upgrade)
- `0x2f54bf6e isOwner(address)` (访问控制)
- 28 个未知 selector (4byte 没收录, 应是业务自定义)
- **结论: 协议 owner 完全有能力救任何丢的 deposit, 找客服即可**

### ⚠️ 索引器激活坑（2026-05-08）
- 仅做 `POST /auth-api/v1/login` 拿 token **不够**: 链上 deposit 不会出现在 `/users/transfers`, funding 余额永远 0
- **必须再调 `GET /api/v1/users/account`** 触发 Rho 后端 indexer 同步该 user 的链上事件
- 前端登录三连: `/login` → `/users/account` → `/auth-api/v1/me` (后两个 token 验证 + 激活)
- 已修: `RhoClient.login()` 自动调 `/users/account`; `verify.mjs` 同步加上
- 旁证: 新钱包 deposit 后只调 login 看不到 transfer 记录, 等多久都没用; 一旦调 `/users/account`, transfer 立刻出现并很快变 confirmed
- 来源: 抓官网登录流量 (login.txt) 对照差异得出

### Daemon 模式（2026-05-08）
- `node trade.mjs [strategy]` 是常驻进程
- 启动流程: 输入密码 → 解密钱包 → 注册 SIGINT/SIGTERM → 进入主循环
- 主循环每轮:
  1. 看今日该策略是否全部 ok → 是则跳过本轮
  2. 否则跑 `runOneCycle`: cleanup 候选钱包 → fetch exchange/info → 跑策略 → 落盘
  3. 计算下次触发 `computeNextRun(hourLocal, minuteLocal, jitterMinutes)`
  4. `sleepUntil` 每 `pollIntervalSeconds` 秒检查一次 shutdown
- **两个策略独立**: 跑两个就开两个进程 (`node trade.mjs instant` 和 `node trade.mjs balance`)，state.json 已按策略分键
- Graceful shutdown: SIGINT/SIGTERM 后等当前 cycle 完成、保存 state、exit
- RhoClient 拦截 401/419 自动重新 login + 重发；5xx/网络错指数退避重试 2 次
- exchange/info 改无 auth 调用 (`fetchExchangeInfo`)，免登录

### 策略架构（2026-05-07/08）
- `strategies/instant.mjs` **策略 1 秒开秒关**（`meta.type: "perWallet"`）：单钱包独立调用 `execute(client, ctx)`，秒开秒关
- `strategies/balance.mjs` **策略 2 配平**（`meta.type: "group"`）：一次随机 2-7 钱包，同 symbol 上 kLong 买 + kShort 卖，两边 notional 总和相等
  - 拆分公式：`longN = unitNotional × kShort`，`shortN = unitNotional × kLong` → `kLong×longN == kShort×shortN`
  - 全员并发开仓 → 持有 `holdSecondsRange` → 全员并发平仓
- `strategies/index.mjs` 注册表
- `lib/state.mjs` 持久化 `state.json`，结构 `{address: {address, runs: {YYYY-MM-DD: {strategy: record}}}}` —— 每天每策略独立
- **每钱包每天每策略一次**：`config.dayBoundary` 决定日切（默认 "local"）
  - 今天该策略 ok → 跳过
  - 今天该策略 failed + retryFailed=true → 重试
  - 跨天后所有钱包重新可执行
- **启动 cleanup phase**（`config.cleanupOnStart`）：扫所有钱包当前 positions，发现非 0 notional 强制 close-position → 实现"今天之内没有平仓的需要平仓"
- 适合 cron 每天跑一次：脚本幂等，重复跑不会多刷

---

## 8. 待办（按优先级）

### P0 - 实盘前必做
- [ ] **手动用 UI 给每个钱包入一次金**（最快路径），让 dryRun 关掉就能跑
- [ ] 抓一次网页下单/取价请求，确认：
  - `tickers/{symbol}` 实际返回字段名（验证 `lastPrice` 兜底是否够）
  - `POST /orders` 的 quantity 是字符串十进制还是 wei 之类（doc 写 string，但小数位精度待验）
  - symbol 命名是 `BTC-PERP` 还是 `BTC_PERP` 还是别的
- [ ] 调一次 `GET /api/v1/exchange/info` 看真实 symbol 列表 + 精度信息，把 `config.symbols` / `quantityPrecision` 替换成动态读取
- [ ] 用一个钱包小额 dryRun=false 跑一轮，盯日志验证开/平流程

### P1 - 框架完善
- [ ] WebSocket 接成交回报：订阅 `user_orders` / `user_positions`，开仓后等成交事件再睡眠，平仓后等仓位归零再下一轮（替换固定 sleep）
- [ ] API Key + HMAC 签名模式：
  - 一次性调 `POST /apikeys` 创建 FullAccess key，secret 用同一套 AES 加密落盘
  - 实现 `signRequest(method, path, query, body)`：拼 payload → HMAC-SHA256 hex
  - 加 `RhoKey / RhoExpiration / RhoSignature` 头
  - 长期跑用 HMAC 模式，避免 Bearer 过期
- [ ] 取价/下单加重试 + 指数退避（参考 xStock checkin.mjs 的 5 次重试结构）
- [ ] 风控：单钱包日内最大开仓次数、最大累计名义额、错误率超阈值熔断

### P2 - 链上入金自动化
- [x] 链 / token / gateway / marketId / tag 全部确认
- [x] `lib/deposit.mjs` + `lib/swap.mjs` 完成全流程: Phase 0 Rho 激活 → Phase 1 LiFi swap (ETH→USDT) → Phase 2 approve+deposit
- [x] 入金 selector + `--amount=N` 上限测试机制
- [ ] 提现：`POST /api/v1/users/withdrawals`（body schema 待抓）；或链上对应函数（待抓 tx）

### P3 - 杠杆 & 保证金管理
- [ ] 翻 Router / margin-account 合约 ABI 找 set-leverage 接口（REST 没有）
- [ ] 自动调杠杆：根据 config 的 leverage 设到目标 margin-account
- [ ] 提现：`POST /api/v1/users/withdrawals`（body schema 待抓）

### P4 - 运维 / 可观测性
- [x] 日志落盘 `logs/trade.log` — `manage.sh` 已支持
- [ ] PnL 统计：每轮记开/平价 + 数量 + 手续费，汇总输出
- [x] 失败钱包重放 — deposit.mjs / trade.mjs 全部按 state 幂等重跑, 不会重复消费
- [x] systemd / pm2 服务化 — `manage.sh` start/stop/restart/status/logs/tail (脚本式, 不依赖 systemd)

---

## 9. 2026-05-08 大补改动汇总

按主题归类，方便定位代码。

### 9.1 钱包基建

| 项 | 实现 |
|---|---|
| 1000 个 EVM 钱包 | `generate-wallets.mjs`：`Wallet.createRandom()`，每个独立 mnemonic + 默认派生 m/44'/60'/0'/0/0；输出 `wallets-generated.csv` 600 权限 |
| 加密 (按列名敏感) | `encrypt.mjs` 按 `SENSITIVE_FIELDS` 集合（`privateKey, Mnemonic, seedPhrase, secret, apiSecret`）选择性加密；其他列（Address, proxy*）保持明文 |
| 解密返回结构 | `cipher.mjs::loadWallets` → `{address, privateKey, mnemonic, proxy: {host,port,username,password}, raw}` |
| 1000 代理一一对应 | `assign-proxies.mjs` 把 Webshare `host:port:user:pass` 文件按行追加到 wallets.csv 的 proxyHost/Port/Username/Password 列 |
| 密码 env 兜底 | `askPassword` 现在优先读 `RHO_PASSWORD` env，不再强制要 TTY |

### 9.2 入金管线（deposit.mjs）

完整流程：

```
Phase 0: Rho 激活 (RhoClient.login() 跑 6 步登录, 否则 indexer 漏 deposit)
Phase 1: LiFi swap ETH→USDT (lib/swap.mjs, integrator=RhoX)
Phase 2: approve(MaxUint256) (allowance < depositAmount 才发, ∞ 时跳过)
Phase 3: Router.deposit(全部 USDT 余额) → funding 账户
```

| 关键改动 | 详情 |
|---|---|
| `--amount=N` CLI flag | 单笔 deposit 上限，`min(usdtBal, N)`；测试时 `--amount=10` 防丢失 |
| selector | `node deposit.mjs 1` / `1-3` / `"10 17"` / `1-3 10 17` |
| selector + flag 共存 | `node deposit.mjs 3 --amount=10` |
| 智能 cleanup | 仅扫候选钱包（今日非 ok 的），不扫已完成的 |
| skip vs fail 计数 | 末尾汇总 `成功 X \| 跳过 Y (eth_low N, usdt_low M) \| 失败 Z` |
| approve 跳过日志 | `approve 已存在 (allowance=∞), 跳过, 省 ~$0.30 gas` |
| amountUsdt 语义反转 | 之前=固定 deposit 数量；**现在=最小阈值**，实际 deposit = 钱包当前 USDT 全部余额 |
| 配置 | `swap.minEthToSwap: 0.009`、`swap.leaveEthForGas: 0.0015`、`swap.slippage: 0.01`、`deposit.amountUsdt: 10` (阈值)、`deposit.minEthForGas: 0.0003` |

### 9.3 LiFi swap (lib/swap.mjs)

| 项 | 实现 |
|---|---|
| 端点 | `GET https://li.quest/v1/quote` (integrator=RhoX) |
| 参数 | `fromAddress / fromChain=1 / toChain=1 / fromToken=0x0 (ETH native) / toToken=USDT / fromAmount / slippage` |
| 直接签发 | `quote.transactionRequest` 字段就是可签 tx (to / data / value)，让 ethers 估 gas，不用 LiFi 给的 stale gasPrice |
| 重试 | getQuote 透代理偶发 ECONNRESET/ETIMEDOUT，加 3 次指数退避 |
| 代理 | LiFi API 走每钱包 HTTP 代理（`wallet.proxy`）；RPC sendTransaction 走主 Infura 池（默认不代理） |

### 9.4 RPC pool (lib/rpc.mjs)

| 项 | 实现 |
|---|---|
| Infura 池 | 8 个 key 数组，配置在 `config.deposit.ethRpcUrls` |
| sticky 选择 | `pickRpcUrl(rpcUrls, walletAddress)`：取地址前 4 字节 hash 模 N，每钱包永远命中同一 key |
| 1000 钱包分布 | 实测 110-140 / 8 key（标准差 10.8，理论 ±11） |
| RPC 代理开关 | `config.deposit.rpcUseProxy: false`（Webshare HTTP 代理跟 Infura 不兼容；sendTransaction 的 from 已链上公开，IP 隐私无意义） |
| 兼容 | 字符串单 URL / 数组多 URL 都吃 |

### 9.5 RhoClient 改造 (lib/rho.mjs)

| 项 | 实现 |
|---|---|
| login 完整 6 步 | `/nonce` → `personal_sign` → `/login` → `/users/account` → `/auth-api/v1/me` → `/margin-accounts/funding` → `/users/positions` → `/margin-accounts` (复刻前端流程) |
| 必须先 login 再 deposit | 否则 indexer 漏 deposit event 永久丢失 (wallet 2 第一笔 25.86 USDT 教训) |
| 401 自动重登 | `_request` 拦截 401/419，标 `reLoggedIn` 后重发一次 |
| 5xx / 网络重试 | `ECONNRESET / ETIMEDOUT / ECONNABORTED / EPIPE / ENOTFOUND / EAI_AGAIN / 5xx / 429` 指数退避 2 次 |
| 行情免登录 | `fetchExchangeInfo()` 模块级函数，不需要 token |
| 并发去重 | login 同一钱包并发只跑一次 |

### 9.6 trade.mjs daemon 模式

| 项 | 实现 |
|---|---|
| 默认行为 | 有 selector → one-shot；无 selector → daemon |
| 显式 flag | `--once` / `--daemon` 覆盖默认 |
| selector 语法 | 跟 deposit.mjs 完全一致 |
| 调度 | `computeNextRun(hour, minute, jitter)` 算下次触发时间 |
| sleep 可中断 | `sleepUntil(when, pollMs, shutdownSignal)` 每 60s 检查 SIGINT |
| Graceful shutdown | SIGINT/SIGTERM → 等当前 cycle 完成 → 保存 state → exit |
| 错误隔离 | cycle 顶层 try/catch，单次失败不杀进程 |
| Cleanup 智能化 | 仅扫今日候选（ok 的不扫） |
| 进度报告 | 每 50 个钱包一行 `进度 N/total (ok=X fail=Y)` |

### 9.7 manage.sh 守护进程管理

```
./manage.sh start [strategy]     启动后台 daemon
./manage.sh stop                 SIGTERM 优雅停 (最多等 5 分钟)
./manage.sh restart [strategy]
./manage.sh status               显示 pid / etime / state.json / 日志大小
./manage.sh logs [N]             tail 最近 N 行
./manage.sh tail                 tail -f 实时跟随
```

密码读取顺序：
1. `RHO_PASSWORD` env
2. 同目录 `.env` 文件中 `RHO_PASSWORD=...`
3. 交互式 read（启动时输入一次，传给 daemon 进程）

PID 文件 `.rho-trade.pid`，日志 `logs/trade.log`，都已加 .gitignore。

### 9.8 策略层改造

#### 策略 1 instant
- `notionalUsdRange: [100, 1000]` 区间随机（替换固定 `notionalUsd`，单值用 `[N, N]`）
- `symbolPrefixes: ["RHO-", "BINANCE-", "OKX-", "BYBIT-", "ASTER-"]` UNION 模式（不再 priority break）
- 候选池实测 10 个不同 market（5 prefix × 2 underlying）
- **多样性强制** (`minDistinctMarketsPerWeek: 3`, `lookbackDays: 7`)：
  - 看本钱包过去 7 天 status=ok 的 records，提取 distinct market（按 `market` 字段，不是 `symbol`）
  - 不足 3 个时候选池过滤掉已交易 → 强制选未交易过的 market
  - 满足后回归纯随机
- 满足项目方"一周内交易 3 个不同市场"任务

#### 策略 2 balance（不变）
- 随机 2-7 钱包配平，kLong*longN = kShort*shortN

### 9.9 wallet 2 第一笔 25.86 USDT 案例（永久教训）

**根因**：deposit 发生时 wallet 2 在 Rho 协议侧从未登录过，`custodyAccount` 不存在。Indexer 扫到 gateway Deposit event 时按 recipient 查 user table 查不到 → **静默丢弃事件，不会回扫**。

**链上证据完整**（钱物理上在 vault `0x7094d8cb...`），但协议侧账本永远 0。

**实测**：
- wallet 1：先 login 后 deposit → 3 分钟到账
- wallet 2 第一笔：先 deposit 后 login → 永远不到账，怎么登录都救不回
- wallet 2 第二笔：先 login (前端)再 deposit → 几分钟到账
- wallet 3：deposit.mjs 新版 Phase 0 先激活 → 到账正常

**implementation 合约的救援能力**：
- `0x17c59b24 transferOut(uint256, address)` —— owner 可手动退款
- 28 个未解析 selector 是业务自定义函数（含可能的"补 credit"工具）

**救援渠道**：Discord https://discord.gg/pmCMcQV35r / 邮箱 support@rhoprotocol.com

### 9.10 项目目录结构（最终）

```
rho-trade/
├── package.json                  ethers / axios / https-proxy-agent
├── manage.sh                     daemon 管理脚本
├── config.mjs                    所有配置
├── trade.mjs                     daemon + one-shot 入口
├── deposit.mjs                   入金管线 (swap + deposit)
├── verify.mjs                    钱包状态检查工具
├── encrypt.mjs / decrypt.mjs     钱包加解密
├── generate-wallets.mjs          生成 N 个 EVM 钱包
├── assign-proxies.mjs            填代理到 wallets.csv
├── lib/
│   ├── cipher.mjs                AES + scrypt + askPassword
│   ├── rho.mjs                   RhoClient (Bearer + 6 步登录 + 重试)
│   ├── deposit.mjs               RhoDeposit (Router.deposit on L1)
│   ├── swap.mjs                  LiFiSwap (ETH→USDT)
│   ├── rpc.mjs                   buildProvider + sticky pool
│   ├── state.mjs                 state.json 读写 + dayKey
│   └── scheduler.mjs             每日触发 + sleepUntil + 信号
├── strategies/
│   ├── index.mjs                 策略注册表
│   ├── instant.mjs               策略 1 秒开秒关 + 多样性
│   └── balance.mjs               策略 2 配平
├── wallets.csv                   1000 钱包 (privateKey/Mnemonic 加密, proxy 明文)
├── .salt                         scrypt salt
├── .env                          RHO_PASSWORD (可选)
├── state.json                    runs[date][strategy] 持久化
├── logs/trade.log                daemon 日志
└── NOTES.md                      本文档
```

### 9.11 同时维护的独立项目

`/Users/fengxiaoji/code/binance-withdraw/`：从 Binance 批量提币到 1000 钱包
- 输入：`key.csv` (Binance API key+secret) + `inputBinance.csv` (含 balance_threshold 列)
- 链上余额阈值检查（高于则跳过）
- `state.json` 持久化，重跑只重试 failed/skipped_threshold
- SOCKS5 proxy（白名单 IP）走 `BINANCE_PROXY_URL`
- ECONNRESET 等瞬时错误自动重试 3 次

---

## 10. 常用命令速查

### 一次性手动执行

```bash
# 入金 (swap + deposit, --amount=10 上限测试)
node deposit.mjs 1-10 --amount=10
node deposit.mjs 1-10                    # 全部余额 deposit

# 策略一次性 (有 selector 自动 one-shot)
node trade.mjs instant 1-10
node trade.mjs balance 1-10              # 注意 balance 要 >= 2 钱包

# 状态检查
node verify.mjs 1-10
node decrypt.mjs 1                        # 看明文私钥+助记词

# 钱包管理
node encrypt.mjs                          # wallets.csv 加密敏感列
node generate-wallets.mjs 1000            # 生成新钱包
node assign-proxies.mjs proxies.txt       # 填代理
```

### 长期 daemon

```bash
./manage.sh start instant                # 后台启动
./manage.sh status
./manage.sh tail                         # 实时跟日志
./manage.sh stop                         # 优雅停止
./manage.sh restart instant
```

---

## 11. 文档原始 URL 索引

- 总览：https://docs.rho.trading/
- Auth API：https://docs.rho.trading/rho-x-api/auth-api
- REST API：https://docs.rho.trading/rho-x-api/rest-api
- WebSocket API：https://docs.rho.trading/rho-x-api/websocket-api
- Auth Swagger：https://api.x.rho.trading/auth-api/v1/swagger/index.html
- 抵押 & 保证金：https://docs.rho.trading/rho-x/collateral-and-margining.md
- 入金教程：https://docs.rho.trading/how-to-trade-on-rho/depositing-collateral.md
- 跨链入金：https://docs.rho.trading/how-to-trade-on-rho/depositing-collateral/cross-chain-deposits.md
- 技术架构：https://docs.rho.trading/rho-x/technical-infrastructure
