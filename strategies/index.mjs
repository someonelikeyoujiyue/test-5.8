import * as instant from "./instant.mjs";
import * as balance from "./balance.mjs";

export const strategies = {
    instant,
    balance,
};

export function getStrategy(name) {
    const s = strategies[name];
    if (!s) throw new Error(`未知策略: ${name}, 已注册: ${Object.keys(strategies).join(",")}`);
    return s;
}
