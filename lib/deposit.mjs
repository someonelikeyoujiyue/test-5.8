import { Wallet, Contract, AbiCoder, MaxUint256, parseUnits, formatUnits, formatEther, toUtf8Bytes } from "ethers";
import { buildProvider } from "./rpc.mjs";

// Rho-X funding 市场入金（Ethereum 主网）
//
// 流程:
//   1) IERC20(USDT).approve(GATEWAY, max_uint256)            // 一次即永久
//   2) GATEWAY.<deposit-fn>(marketId, amount, token, recipient, tag, deadline)
//      selector 0xba2ba716 (Diamond proxy 路由, 函数名未公开)
//
// 每钱包独立 JsonRpcProvider, 通过 wallet.proxy 走 HTTP 代理

const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address owner, address spender) view returns (uint256)",
    "function approve(address spender, uint256 amount) returns (bool)",
    "function decimals() view returns (uint8)",
];

const DEPOSIT_SELECTOR = "0xba2ba716";
const DEPOSIT_PARAM_TYPES = ["bytes32", "uint256", "address", "address", "bytes", "uint256"];

export class RhoDeposit {
    constructor({ rpcUrl, gateway, token, marketId, tag, deadlineSeconds = 600, useProxy = false }) {
        this.rpcUrl = rpcUrl;
        this.gatewayAddr = gateway;
        this.tokenAddr = token;
        this.marketId = marketId;
        this.tagBytes = toUtf8Bytes(tag);
        this.deadlineSeconds = deadlineSeconds;
        this.useProxy = useProxy;       // RPC 是否走每钱包代理 (默认 false, Webshare↔Infura 不兼容)
        this.coder = AbiCoder.defaultAbiCoder();
        this._providerCache = new Map();    // address → Provider, 避免每次重新握手
    }

    _getProvider(wallet) {
        const key = wallet.address.toLowerCase();
        let p = this._providerCache.get(key);
        if (!p) {
            const proxy = this.useProxy ? wallet.proxy : null;
            p = buildProvider(this.rpcUrl, proxy, wallet.address);
            this._providerCache.set(key, p);
        }
        return p;
    }

    _connect(wallet) {
        const provider = this._getProvider(wallet);
        const signer = new Wallet(wallet.privateKey, provider);
        const usdt = new Contract(this.tokenAddr, ERC20_ABI, signer);
        return { signer, usdt, provider };
    }

    async preflight(wallet, amountHuman, minEthHuman) {
        const { signer, usdt, provider } = this._connect(wallet);
        const [ethBal, usdtBal, allowance, decimals] = await Promise.all([
            provider.getBalance(signer.address),
            usdt.balanceOf(signer.address),
            usdt.allowance(signer.address, this.gatewayAddr),
            usdt.decimals(),
        ]);
        const amount = parseUnits(String(amountHuman), decimals);
        const minEth = parseUnits(String(minEthHuman), 18);
        return {
            address: signer.address,
            ethBal, usdtBal, allowance, decimals, amount, minEth,
            ethOk: ethBal >= minEth,
            usdtOk: usdtBal >= amount,
            needApprove: allowance < amount,
        };
    }

    encodeDepositCalldata(recipient, amount, deadline) {
        const params = this.coder.encode(
            DEPOSIT_PARAM_TYPES,
            [this.marketId, amount, this.tokenAddr, recipient, this.tagBytes, deadline]
        );
        return DEPOSIT_SELECTOR + params.slice(2);
    }

    async approveMax(wallet) {
        const { usdt } = this._connect(wallet);
        const tx = await usdt.approve(this.gatewayAddr, MaxUint256);
        return tx;
    }

    async deposit(wallet, amount) {
        const { signer } = this._connect(wallet);
        const deadline = Math.floor(Date.now() / 1000) + this.deadlineSeconds;
        const data = this.encodeDepositCalldata(signer.address, amount, deadline);
        const tx = await signer.sendTransaction({
            to: this.gatewayAddr,
            data,
            value: 0n,
        });
        return { tx, deadline };
    }
}

export function fmtToken(raw, decimals) {
    return formatUnits(raw, decimals);
}

export function fmtEth(raw) {
    return formatEther(raw);
}
