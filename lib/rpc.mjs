// 每钱包独立的 ethers JsonRpcProvider, 通过 HttpsProxyAgent 走该钱包的 HTTP 代理
//
// ethers v6 的 FetchRequest.createGetUrlFunc({ agent }) 接受 Node.js http(s).Agent,
// 这是把 proxy 接到 ethers 的官方途径
//
// Provider 调优 (针对 Infura -32005 Too Many Requests):
//   - batchMaxCount=1: 不批量, 一个 RPC 一个 HTTP 请求, 出错只影响那一笔
//   - pollingInterval=12000: 默认 4s 改 12s, tx.wait 轮询频率降 3x
//   - _send 包装层重试 -32005 (JSON-RPC 速率限制, ethers 默认不重试)

import { JsonRpcProvider, FetchRequest } from "ethers";
import { HttpsProxyAgent } from "https-proxy-agent";

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 检测 ethers v6 BAD_DATA + 内部含 -32005 的错误
function isRateLimit(e) {
    if (!e) return false;
    if (e.code === "BAD_DATA") {
        const arr = Array.isArray(e.value) ? e.value : [e.value];
        return arr.some(v => v && v.code === -32005);
    }
    if (e.code === -32005) return true;
    return false;
}

// monkey-patch provider._send 加重试 (-32005 退避 0.5/1/2/4 秒)
function wrapSendWithRetry(provider, label = "rpc") {
    const orig = provider._send.bind(provider);
    provider._send = async function(payload) {
        let lastErr;
        for (let i = 1; i <= 5; i++) {
            try {
                return await orig(payload);
            } catch (e) {
                lastErr = e;
                if (!isRateLimit(e) || i === 5) throw e;
                const wait = 500 * Math.pow(2, i - 1) + Math.floor(Math.random() * 200);
                console.warn(`[${label}] Infura -32005 限流, ${wait}ms 后重试 (${i}/5)`);
                await sleep(wait);
            }
        }
        throw lastErr;
    };
    return provider;
}

// 按钱包地址 hash 从 RPC 池里 sticky 选一个; 字符串直接返回; 单元素数组返回首个;
// 多元素 + 没 walletAddress -> 随机
export function pickRpcUrl(rpcUrlOrUrls, walletAddress) {
    if (typeof rpcUrlOrUrls === "string") return rpcUrlOrUrls;
    if (!Array.isArray(rpcUrlOrUrls) || rpcUrlOrUrls.length === 0) {
        throw new Error("rpcUrl 必须是字符串或非空数组");
    }
    if (rpcUrlOrUrls.length === 1) return rpcUrlOrUrls[0];
    if (!walletAddress) return rpcUrlOrUrls[Math.floor(Math.random() * rpcUrlOrUrls.length)];
    // 用地址前 4 字节做 hash, sticky 分桶
    const idx = parseInt(walletAddress.toLowerCase().slice(2, 10), 16) % rpcUrlOrUrls.length;
    return rpcUrlOrUrls[idx];
}

const PROVIDER_OPTS = {
    batchMaxCount: 1,         // 不批量, 单个 RPC 一个 HTTP, -32005 只影响一个请求
    pollingInterval: 12000,   // 12s 轮询 (默认 4s, 太频繁触发限流)
};

export function buildProvider(rpcUrlOrUrls, walletProxy, walletAddress) {
    const rpcUrl = pickRpcUrl(rpcUrlOrUrls, walletAddress);
    const label = walletAddress ? walletAddress.slice(0, 10) : "rpc";
    let provider;
    if (!walletProxy) {
        provider = new JsonRpcProvider(rpcUrl, undefined, PROVIDER_OPTS);
    } else {
        const auth = walletProxy.username
            ? `${encodeURIComponent(walletProxy.username)}:${encodeURIComponent(walletProxy.password)}@`
            : "";
        const proxyUrl = `http://${auth}${walletProxy.host}:${walletProxy.port}`;
        const agent = new HttpsProxyAgent(proxyUrl);
        const fr = new FetchRequest(rpcUrl);
        fr.getUrlFunc = FetchRequest.createGetUrlFunc({ agent });
        provider = new JsonRpcProvider(fr, undefined, PROVIDER_OPTS);
    }
    return wrapSendWithRetry(provider, label);
}
