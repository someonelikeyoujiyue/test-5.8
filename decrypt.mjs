import { fileURLToPath } from "url";
import { dirname } from "path";
import { askPassword, loadWallets } from "./lib/cipher.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

function parseRange(arg, max) {
    if (!arg) return { start: 1, end: max };
    const m = arg.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) { console.log("用法: node decrypt.mjs [N | N-M]"); process.exit(1); }
    const start = parseInt(m[1]);
    const end = m[2] ? parseInt(m[2]) : start;
    if (start < 1 || end < start || start > max) {
        console.log(`范围无效，共 ${max} 条`);
        process.exit(1);
    }
    return { start, end: Math.min(end, max) };
}

async function main() {
    const password = await askPassword("请输入解密密码: ");
    let wallets;
    try {
        wallets = loadWallets(__dirname, password);
    } catch (e) {
        console.log("解密失败:", e.message);
        process.exit(1);
    }
    const { start, end } = parseRange(process.argv[2], wallets.length);
    console.log(`\n共 ${wallets.length} 个钱包，显示 ${start}-${end}\n`);
    for (let i = start - 1; i < end; i++) {
        console.log(`[${i + 1}] ${wallets[i].address}`);
        console.log(`    pk  : ${wallets[i].privateKey}`);
        if (wallets[i].mnemonic) console.log(`    seed: ${wallets[i].mnemonic}`);
        if (wallets[i].extra?.length) {
            wallets[i].extra.forEach((v, j) => console.log(`    ext${j}: ${v}`));
        }
        console.log();
    }
}

main();
