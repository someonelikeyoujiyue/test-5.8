import fs from "fs";
import { join } from "path";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const CTRL_C = String.fromCharCode(0x03);
const CTRL_D = String.fromCharCode(0x04);
const DEL = String.fromCharCode(0x7f);

export function askPassword(prompt) {
    // env 优先, 用于 manage.sh 后台启动等非交互场景
    if (process.env.RHO_PASSWORD) {
        process.stdout.write(`${prompt}(从 RHO_PASSWORD env 读取)\n`);
        return Promise.resolve(process.env.RHO_PASSWORD);
    }
    // 非 TTY 但没设 env: 让用户知道
    if (!process.stdin.isTTY) {
        return Promise.reject(new Error("非 TTY 且未设 RHO_PASSWORD 环境变量, 无法读取密码"));
    }
    return new Promise(resolve => {
        process.stdout.write(prompt);
        const stdin = process.stdin;
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding("utf8");

        let password = "";
        const onData = c => {
            if (c === "\n" || c === "\r" || c === CTRL_D) {
                stdin.setRawMode(false);
                stdin.pause();
                stdin.removeListener("data", onData);
                process.stdout.write("\n");
                resolve(password);
            } else if (c === CTRL_C) {
                process.exit();
            } else if (c === DEL || c === "\b") {
                if (password.length > 0) {
                    password = password.slice(0, -1);
                    process.stdout.write("\b \b");
                }
            } else {
                password += c;
            }
        };
        stdin.on("data", onData);
    });
}

export function loadOrInitSalt(dir) {
    const path = join(dir, ".salt");
    if (fs.existsSync(path)) {
        return Buffer.from(fs.readFileSync(path, "utf8").trim(), "hex");
    }
    const salt = randomBytes(16);
    fs.writeFileSync(path, salt.toString("hex"), "utf8");
    fs.chmodSync(path, 0o600);
    console.log(`[init] 生成新的 .salt (${path})，请妥善保管`);
    return salt;
}

export function deriveKey(password, salt) {
    return scryptSync(password, salt, 32);
}

export function encryptField(text, key) {
    const iv = randomBytes(16);
    const cipher = createCipheriv("aes-256-cbc", key, iv);
    let enc = cipher.update(text, "utf8", "hex");
    enc += cipher.final("hex");
    return iv.toString("hex") + ":" + enc;
}

export function decryptField(encStr, key) {
    const [ivHex, encHex] = encStr.split(":");
    const iv = Buffer.from(ivHex, "hex");
    const decipher = createDecipheriv("aes-256-cbc", key, iv);
    let dec = decipher.update(encHex, "hex", "utf8");
    dec += decipher.final("utf8");
    return dec;
}

export function isEncrypted(field) {
    return typeof field === "string" && /^[0-9a-f]{32}:[0-9a-f]+$/.test(field);
}

// 列名为 SENSITIVE_FIELDS 之一的列会被 encrypt.mjs 加密, loadWallets 解密;
// 其他列 (Address, proxyHost, proxyPort, proxyUsername, proxyPassword 等) 保持明文
export const SENSITIVE_FIELDS = new Set([
    "privateKey", "Mnemonic", "seedPhrase", "secret", "apiSecret",
]);

// 返回结构: { address, privateKey, mnemonic, proxy: {host, port, username, password} | null, raw: {...} }
export function loadWallets(dir, password) {
    const csvPath = join(dir, "wallets.csv");
    if (!fs.existsSync(csvPath)) throw new Error(`wallets.csv 不存在: ${csvPath}`);
    const saltPath = join(dir, ".salt");
    if (!fs.existsSync(saltPath)) throw new Error(".salt 不存在，先跑 npm run encrypt");
    const salt = Buffer.from(fs.readFileSync(saltPath, "utf8").trim(), "hex");
    const key = deriveKey(password, salt);

    const lines = fs.readFileSync(csvPath, "utf8")
        .split("\n").map(v => v.trim()).filter(v => v);
    const headerCols = lines[0].split(",");
    const rows = lines.slice(1);

    return rows.map((line, i) => {
        const cols = line.split(",");
        const obj = {};
        headerCols.forEach((h, idx) => {
            let v = cols[idx] ?? "";
            if (v && SENSITIVE_FIELDS.has(h)) {
                if (!isEncrypted(v)) {
                    throw new Error(`第 ${i + 1} 行列 "${h}" 未加密, 先跑 npm run encrypt`);
                }
                v = decryptField(v, key);
            }
            obj[h] = v || null;
        });
        const proxy = obj.proxyHost && obj.proxyPort ? {
            host: obj.proxyHost,
            port: obj.proxyPort,
            username: obj.proxyUsername || "",
            password: obj.proxyPassword || "",
        } : null;
        return {
            address: obj.Address,
            privateKey: obj.privateKey,
            mnemonic: obj.Mnemonic ?? null,
            proxy,
            raw: obj,
        };
    });
}
