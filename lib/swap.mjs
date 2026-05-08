// LiFi 跨/同链 swap (重点: Ethereum L1 ETH -> USDT, integrator=RhoX)
//
// 抓自 RhoX 前端: GET https://li.quest/v1/quote?fromAddress=...&fromChain=1&toChain=1
//                    &fromToken=0x0...&toToken=0xdAC17F...&fromAmount=...&integrator=RhoX
// 响应里含 transactionRequest = { to, data, value, chainId, gasLimit, gasPrice, from }
// 直接拿 wallet 签名 + sendTransaction 即可
//
// 注意:
//   - value 已经包含 LiFi 0.25% fee, 不要自行加减
//   - gasPrice 在 quote 里是 stale 的, 我们不用, 让节点估算
//   - 同 walletProxy 跟 rho-trade 现有 HttpsProxyAgent 一致

import axios from "axios";
import { Wallet } from "ethers";
import { HttpsProxyAgent } from "https-proxy-agent";
import { buildProvider } from "./rpc.mjs";

const LIFI_BASE = "https://li.quest/v1";
const ETH_NATIVE = "0x0000000000000000000000000000000000000000";
const USDT_ETHEREUM = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

export class LiFiSwap {
    constructor({ rpcUrl, integrator = "RhoX", slippage = 0.005, origin = "https://x.rho.trading", useProxy = false }) {
        this.rpcUrl = rpcUrl;
        this.integrator = integrator;
        this.slippage = slippage;
        this.origin = origin;
        this.useProxy = useProxy;
        this._providerCache = new Map();
    }

    _getProvider(walletProxy, walletAddress) {
        const key = walletAddress?.toLowerCase() ?? "_default";
        let p = this._providerCache.get(key);
        if (!p) {
            const proxy = this.useProxy ? walletProxy : null;
            p = buildProvider(this.rpcUrl, proxy, walletAddress);
            this._providerCache.set(key, p);
        }
        return p;
    }

    _http(walletProxy) {
        const cfg = {
            baseURL: LIFI_BASE,
            timeout: 30000,
            headers: {
                "x-lifi-integrator": this.integrator,
                "Origin": this.origin,
                "Referer": this.origin + "/",
                "Accept": "*/*",
                "User-Agent": "Mozilla/5.0",
            },
        };
        if (walletProxy) {
            const auth = walletProxy.username
                ? `${encodeURIComponent(walletProxy.username)}:${encodeURIComponent(walletProxy.password)}@`
                : "";
            const url = `http://${auth}${walletProxy.host}:${walletProxy.port}`;
            const agent = new HttpsProxyAgent(url);
            cfg.httpAgent = agent;
            cfg.httpsAgent = agent;
        }
        return axios.create(cfg);
    }

    async getQuote({ fromAddress, fromAmount, fromToken = ETH_NATIVE, toToken = USDT_ETHEREUM, walletProxy }) {
        const http = this._http(walletProxy);
        const params = {
            fromAddress,
            fromChain: 1,
            toChain: 1,
            fromToken,
            toToken,
            fromAmount: fromAmount.toString(),
            integrator: this.integrator,
            slippage: this.slippage,
        };
        // 代理偶发 ETIMEDOUT/ECONNRESET, 重试 2 次, 指数退避
        const retryCodes = ["ECONNRESET", "ETIMEDOUT", "ECONNABORTED", "EPIPE", "ECONNREFUSED"];
        let lastErr;
        for (let i = 1; i <= 3; i++) {
            try {
                const r = await http.get("/quote", { params });
                return r.data;
            } catch (e) {
                lastErr = e;
                const transient = retryCodes.includes(e.code) || (e.response?.status >= 500);
                if (!transient || i === 3) throw e;
                await new Promise(r => setTimeout(r, 1000 * i + Math.random() * 500));
            }
        }
        throw lastErr;
    }

    // 用 quote 拿到的 transactionRequest 直接签发, RPC 走代理
    async signAndSend({ privateKey, walletAddress, txReq, walletProxy }) {
        const provider = this._getProvider(walletProxy, walletAddress);
        const signer = new Wallet(privateKey, provider);
        const tx = await signer.sendTransaction({
            to: txReq.to,
            data: txReq.data,
            value: BigInt(txReq.value),
            gasLimit: txReq.gasLimit ? BigInt(txReq.gasLimit) : undefined,
        });
        return tx;
    }

    // 高层封装: ETH -> USDT
    async swapEthToUsdt({ privateKey, walletAddress, amountWei, walletProxy }) {
        const quote = await this.getQuote({
            fromAddress: walletAddress,
            fromAmount: amountWei,
            walletProxy,
        });
        if (!quote?.transactionRequest) {
            throw new Error(`quote 缺 transactionRequest: ${JSON.stringify(quote).slice(0, 300)}`);
        }
        const tx = await this.signAndSend({ privateKey, walletAddress, txReq: quote.transactionRequest, walletProxy });
        return {
            tx,
            tool: quote.tool,
            toAmountMin: quote.estimate?.toAmountMin,
            toAmountExpected: quote.estimate?.toAmount,
            quoteId: quote.id,
        };
    }
}
