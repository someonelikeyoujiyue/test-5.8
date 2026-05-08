// 每钱包独立的 ethers JsonRpcProvider, 通过 HttpsProxyAgent 走该钱包的 HTTP 代理
//
// ethers v6 的 FetchRequest.createGetUrlFunc({ agent }) 接受 Node.js http(s).Agent,
// 这是把 proxy 接到 ethers 的官方途径

import { JsonRpcProvider, FetchRequest } from "ethers";
import { HttpsProxyAgent } from "https-proxy-agent";

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

export function buildProvider(rpcUrlOrUrls, walletProxy, walletAddress) {
    const rpcUrl = pickRpcUrl(rpcUrlOrUrls, walletAddress);
    if (!walletProxy) return new JsonRpcProvider(rpcUrl);
    const auth = walletProxy.username
        ? `${encodeURIComponent(walletProxy.username)}:${encodeURIComponent(walletProxy.password)}@`
        : "";
    const proxyUrl = `http://${auth}${walletProxy.host}:${walletProxy.port}`;
    const agent = new HttpsProxyAgent(proxyUrl);
    const fr = new FetchRequest(rpcUrl);
    fr.getUrlFunc = FetchRequest.createGetUrlFunc({ agent });
    return new JsonRpcProvider(fr);
}
