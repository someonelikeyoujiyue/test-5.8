// 生成 N 个 EVM 钱包: 各自随机 12 词助记词 + 默认派生路径 m/44'/60'/0'/0/0 的私钥/地址
//
// 用法: node generate-wallets.mjs [count=1000] [outFile=wallets-generated.csv]
//
// 安全:
//   - 输出文件权限 0600
//   - 不打印任何私钥/助记词到终端
//   - 已存在的目标文件不覆盖, 退出报错

import fs from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { Wallet } from "ethers";

const __dirname = dirname(fileURLToPath(import.meta.url));

const COUNT = parseInt(process.argv[2] ?? "1000");
const OUT = join(__dirname, process.argv[3] ?? "wallets-generated.csv");

if (!Number.isInteger(COUNT) || COUNT < 1 || COUNT > 100000) {
    console.log("count 应为 [1, 100000] 整数");
    process.exit(1);
}
if (fs.existsSync(OUT)) {
    console.log(`目标已存在: ${OUT}\n先重命名或删除再跑, 避免覆盖`);
    process.exit(1);
}

console.log(`开始生成 ${COUNT} 个 EVM 钱包 (默认派生路径)`);

const lines = ["Address,privateKey,Mnemonic"];
const t0 = Date.now();
for (let i = 0; i < COUNT; i++) {
    const w = Wallet.createRandom();
    lines.push(`${w.address},${w.privateKey},${w.mnemonic.phrase}`);
    if ((i + 1) % 100 === 0) {
        const speed = ((i + 1) / ((Date.now() - t0) / 1000)).toFixed(0);
        process.stdout.write(`\r  ${i + 1}/${COUNT}  (${speed}/s)`);
    }
}
process.stdout.write("\n");

fs.writeFileSync(OUT, lines.join("\n") + "\n");
fs.chmodSync(OUT, 0o600);

console.log(`\n完成: ${OUT}`);
console.log(`权限: 600 (仅当前用户可读)`);
console.log(`耗时: ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
console.log(`下一步:`);
console.log(`  1. 检查文件: head -3 ${OUT}`);
console.log(`  2. 改名为 wallets.csv: mv ${OUT} wallets.csv`);
console.log(`  3. 加密 (会同时加密 privateKey 和 Mnemonic 两列):`);
console.log(`       npm run encrypt`);
