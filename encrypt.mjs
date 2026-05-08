import fs from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { askPassword, loadOrInitSalt, deriveKey, encryptField, decryptField, isEncrypted, SENSITIVE_FIELDS } from "./lib/cipher.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
    const csvPath = join(__dirname, "wallets.csv");
    if (!fs.existsSync(csvPath)) {
        console.log("wallets.csv 不存在，参考 wallets.csv.example 创建");
        process.exit(1);
    }

    const lines = fs.readFileSync(csvPath, "utf8")
        .split("\n").map(v => v.trim()).filter(v => v);
    const headerCols = lines[0].split(",");

    // 按列名识别敏感列
    const sensitiveIdx = headerCols
        .map((h, i) => SENSITIVE_FIELDS.has(h) ? i : -1)
        .filter(i => i !== -1);
    if (!sensitiveIdx.length) {
        console.log(`未找到敏感列, 已知敏感列名: ${[...SENSITIVE_FIELDS].join(", ")}`);
        process.exit(1);
    }
    const sensitiveNames = sensitiveIdx.map(i => headerCols[i]).join(", ");

    // 检查首行 sensitive 列是否已经加密 (跑过 encrypt 后再跑会跳出)
    if (lines.length > 1) {
        const firstRow = lines[1].split(",");
        const allEncrypted = sensitiveIdx.every(i => isEncrypted(firstRow[i] || ""));
        if (allEncrypted) {
            console.log(`wallets.csv 的敏感列 (${sensitiveNames}) 已加密, 无需重复加密`);
            process.exit(1);
        }
    }

    console.log(`检测到 ${lines.length - 1} 个钱包`);
    console.log(`将加密的列: ${sensitiveNames}`);
    console.log(`其他列 (含 Address / proxy*) 保持明文`);

    const password = await askPassword("请输入加密密码: ");
    if (!password) { console.log("密码不能为空"); process.exit(1); }
    const confirm = await askPassword("请再次输入密码确认: ");
    if (password !== confirm) { console.log("两次密码不一致"); process.exit(1); }

    const salt = loadOrInitSalt(__dirname);
    const key = deriveKey(password, salt);

    const out = [lines[0]];
    for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(",");
        for (const idx of sensitiveIdx) {
            if (cols[idx]) cols[idx] = encryptField(cols[idx], key);
        }
        out.push(cols.join(","));
    }

    // 自检: 第 1 行所有 sensitive 列解密回去 == 原文
    const origCols = lines[1].split(",");
    const newCols = out[1].split(",");
    for (const idx of sensitiveIdx) {
        const dec = newCols[idx] ? decryptField(newCols[idx], key) : "";
        if (dec !== (origCols[idx] || "")) {
            console.log(`自检失败 (列 ${headerCols[idx]})，未写入`);
            process.exit(1);
        }
    }

    fs.writeFileSync(csvPath, out.join("\n") + "\n", "utf8");
    fs.chmodSync(csvPath, 0o600);
    console.log(`完成: ${lines.length - 1} 个钱包已加密 (敏感列: ${sensitiveNames})`);
}

main();
