import axios from "axios";
import { Wallet } from "ethers";

// Rho-X REST 客户端 - Bearer access token 模式
//
// 流程:
//   1) POST /auth-api/v1/nonce       { address }                -> { messageToSign }
//   2) personal_sign(messageToSign)
//   3) POST /auth-api/v1/login       { address, signature, type:"evm" } -> { token }
//   4) 后续请求带 Authorization: Bearer <token>
//
// 长跑特性:
//   - 401 / 419 / "token expired" 自动重新 login + 重发一次
//   - 5xx / ECONNRESET / 429 退避重试 (默认 2 次, 总计 3 次)
//
// 备注: API Key + HMAC 模式没实现, 见 NOTES.md

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_CODES = new Set(["ECONNABORTED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"]);
const TOKEN_EXPIRED_STATUS = new Set([401, 419]);

const sleep = ms => new Promise(r => setTimeout(r, ms));

export class RhoClient {
    constructor({ apiBase, privateKey, httpAgent = null, maxRetries = 2, retryBaseMs = 500 }) {
        this.apiBase = apiBase.replace(/\/$/, "");
        this.wallet = new Wallet(privateKey);
        this.address = this.wallet.address;
        this.token = null;
        this.maxRetries = maxRetries;
        this.retryBaseMs = retryBaseMs;
        this.http = axios.create({
            baseURL: this.apiBase,
            timeout: 20000,
            httpAgent,
            httpsAgent: httpAgent,
            validateStatus: s => s >= 200 && s < 300,
        });
        this._loginInFlight = null;
    }

    _authHeaders() {
        if (!this.token) throw new Error("尚未登录，先调 login()");
        return { Authorization: `Bearer ${this.token}` };
    }

    // 单次 login (并发去重)
    // 模拟前端完整登录流程 (从 login.txt 抓包):
    //   1. POST /auth-api/v1/nonce
    //   2. personal_sign(messageToSign)
    //   3. POST /auth-api/v1/login
    //   4. GET  /api/v1/users/account
    //   5. GET  /auth-api/v1/me
    //   6. GET  /api/v1/margin-accounts/funding
    //   7. GET  /api/v1/users/positions
    //   8. GET  /api/v1/margin-accounts
    // 实测必须完整跑一遍, 协议侧 indexer 才会认领该 user 的 deposit event;
    // 不调或者只调前 3 个, deposit 链上 confirm 也不会 credit 到 userId.
    async login() {
        if (this._loginInFlight) return this._loginInFlight;
        this._loginInFlight = (async () => {
            try {
                const nonceRes = await this.http.post("/auth-api/v1/nonce", { address: this.address });
                const msg = nonceRes.data.messageToSign;
                if (!msg) throw new Error(`nonce 响应缺 messageToSign: ${JSON.stringify(nonceRes.data)}`);
                const signature = await this.wallet.signMessage(msg);
                const loginRes = await this.http.post("/auth-api/v1/login", {
                    address: this.address, signature, type: "evm",
                });
                this.token = loginRes.data.token;
                if (!this.token) throw new Error(`login 响应缺 token: ${JSON.stringify(loginRes.data)}`);

                // 后 5 个 warmup GET, 串行按前端顺序; 单个失败不阻塞, warn 一下继续
                const warmup = [
                    "/api/v1/users/account",
                    "/auth-api/v1/me",
                    "/api/v1/margin-accounts/funding",
                    "/api/v1/users/positions",
                    "/api/v1/margin-accounts",
                ];
                const collected = {};
                for (const path of warmup) {
                    try {
                        const r = await this.http.get(path, { headers: this._authHeaders() });
                        collected[path] = r.data;
                    } catch (e) {
                        console.warn(`[${this.address.slice(0, 10)}] warmup ${path} 失败: ${e.message}`);
                    }
                }
                this.userInfo = {
                    userId: collected["/auth-api/v1/me"]?.userId
                        ?? collected["/api/v1/users/account"]?.account?.userId,
                    custodyAccounts: collected["/auth-api/v1/me"]?.custodyAccounts,
                };

                return this.token;
            } finally {
                this._loginInFlight = null;
            }
        })();
        return this._loginInFlight;
    }

    // 显式重新触发索引器同步; 已登录后可单独调用
    async refreshIndex() {
        if (!this.token) await this.login();
        return this._request({ method: "get", url: "/api/v1/users/account" });
    }

    async logout() {
        if (!this.token) return;
        try {
            await this.http.post("/auth-api/v1/logout", { token: this.token }, { headers: this._authHeaders() });
        } catch {}
        this.token = null;
    }

    // 带 401 重登 + 5xx/网络重试
    async _request({ method, url, data, params, auth = true }) {
        let lastErr;
        let reLoggedIn = false;
        const totalAttempts = this.maxRetries + 1;
        for (let attempt = 1; attempt <= totalAttempts; attempt++) {
            try {
                const opts = { method, url, params };
                if (data !== undefined) opts.data = data;
                if (auth) opts.headers = this._authHeaders();
                const res = await this.http.request(opts);
                return res.data;
            } catch (e) {
                lastErr = e;
                const status = e.response?.status;
                const code = e.code;

                // 401: 重新 login (仅一次), 不计入重试次数
                if (auth && status && TOKEN_EXPIRED_STATUS.has(status) && !reLoggedIn) {
                    reLoggedIn = true;
                    this.token = null;
                    try { await this.login(); }
                    catch (le) { throw le; }
                    attempt--; // 不消耗重试预算
                    continue;
                }

                // 重试条件
                const retriable =
                    (status && RETRY_STATUS.has(status)) ||
                    (code && RETRY_CODES.has(code));
                if (!retriable || attempt >= totalAttempts) throw e;

                const wait = this.retryBaseMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 200);
                await sleep(wait);
            }
        }
        throw lastErr;
    }

    // ---- Market data (无需 auth) ----
    async getTicker(symbol) {
        return this._request({ method: "get", url: `/api/v1/tickers/${encodeURIComponent(symbol)}`, auth: false });
    }
    async getExchangeInfo() {
        return this._request({ method: "get", url: "/api/v1/exchange/info", auth: false });
    }

    // ---- Account ----
    async listMarginAccounts() {
        return this._request({ method: "get", url: "/api/v1/margin-accounts" });
    }
    async getPositions(marginAccount) {
        return this._request({
            method: "get",
            url: "/api/v1/users/positions",
            params: marginAccount ? { marginAccount } : undefined,
        });
    }

    // ---- Orders ----
    async createOrder(body) {
        return this._request({ method: "post", url: "/api/v1/orders", data: body });
    }
    async cancelOrder({ orderId, clientOrderId }) {
        return this._request({ method: "post", url: "/api/v1/orders/cancel", data: { orderId, clientOrderId } });
    }
    async cancelAll(filter = {}) {
        return this._request({ method: "post", url: "/api/v1/orders/cancel-all", data: filter });
    }

    // 高层封装
    async openMarket({ symbol, side, quantity, clientOrderId }) {
        return this.createOrder({ orderType: "market", symbol, side, quantity: String(quantity), timeInForce: "IOC", clientOrderId });
    }
    async closeMarket({ symbol, clientOrderId }) {
        // close-position flag 不能带 side, 服务端自动反向
        return this.createOrder({ orderType: "market", symbol, timeInForce: "IOC", flags: ["close-position"], clientOrderId });
    }
}

// 不需要 auth 的便捷函数 (拉 exchange/info 不必先 login)
export async function fetchExchangeInfo(apiBase, opts = {}) {
    const http = axios.create({ baseURL: apiBase.replace(/\/$/, ""), timeout: 20000, ...opts });
    const res = await http.get("/api/v1/exchange/info");
    return res.data;
}
