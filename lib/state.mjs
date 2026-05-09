import fs from "fs";

// state.json 结构 (v2):
// {
//   "<address-lowercase>": {
//     "address": "<原 case>",
//     "runs": {
//       "YYYY-MM-DD": {
//         "instant": [
//           { strategy, status, ts, symbol, side, ... },   // 第 1 笔
//           { ... },                                          // 第 2 笔
//           ...
//         ],
//         "balance": [...]
//       }
//     }
//   }
// }
//
// v1 兼容: 旧版本是单个 record (object), 不是数组. loadState 读到时
// 不强制迁移文件, 但所有 getter 都 wrap 成 array; 下次 saveState 时落盘成 array.

export function loadState(file) {
    if (!fs.existsSync(file)) return {};
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (e) {
        console.warn(`state 文件损坏 (${e.message}), 备份到 .bak 后重置`);
        fs.copyFileSync(file, file + ".bak");
        return {};
    }
}

export function saveState(file, state) {
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, file);
}

export function recordKey(address) {
    return address.toLowerCase();
}

// dayBoundary: "local" | "UTC" | IANA TZ (例 "Asia/Shanghai")
export function dayKey(date = new Date(), boundary = "local") {
    if (boundary === "UTC") return date.toISOString().slice(0, 10);
    if (boundary === "local") return date.toLocaleDateString("sv-SE");
    return new Intl.DateTimeFormat("sv-SE", { timeZone: boundary }).format(date);
}

// 拿当天该策略的所有 records (array). 没记录返回 [].
// 兼容 v1: 如果是单个 object 自动包装成 [object]
export function getDayRuns(state, address, day, strategy) {
    const v = state[recordKey(address)]?.runs?.[day]?.[strategy];
    if (v == null) return [];
    if (Array.isArray(v)) return v;
    return [v];
}

// 当天该策略 ok 状态的 records 数量
export function countOk(state, address, day, strategy) {
    return getDayRuns(state, address, day, strategy).filter(r => r?.status === "ok").length;
}

// 追加 1 笔 record (而不是覆盖). 自动 v1 → v2 迁移.
export function appendRun(state, address, day, strategy, record) {
    const k = recordKey(address);
    if (!state[k]) state[k] = { address, runs: {} };
    if (!state[k].runs) state[k].runs = {};
    if (!state[k].runs[day]) state[k].runs[day] = {};
    const cur = state[k].runs[day][strategy];
    let arr;
    if (cur == null) arr = [];
    else if (Array.isArray(cur)) arr = cur;
    else arr = [cur];   // v1 → v2 in-memory 迁移
    arr.push(record);
    state[k].runs[day][strategy] = arr;
}

// 兼容旧 API: 取最近一笔 (大多数读场景仍可用)
export function getRun(state, address, day, strategy) {
    const arr = getDayRuns(state, address, day, strategy);
    return arr[arr.length - 1];
}

// 兼容旧 API (deposit.mjs 单次写, balance 等): 覆盖式写, 用 array 单元素
export function setRun(state, address, day, strategy, record) {
    const k = recordKey(address);
    if (!state[k]) state[k] = { address, runs: {} };
    if (!state[k].runs) state[k].runs = {};
    if (!state[k].runs[day]) state[k].runs[day] = {};
    state[k].runs[day][strategy] = [record];
}

// 汇总: 钱包数 + ok records 总数 + failed records 总数 + 满 N 次的钱包数
export function summary(state, day, strategy, runsPerDay = 1) {
    let ok = 0, failed = 0, addresses = 0, walletsCompleted = 0;
    for (const entry of Object.values(state)) {
        addresses++;
        const arr = getDayRuns(state, entry.address, day, strategy);
        let wOk = 0;
        for (const r of arr) {
            if (r?.status === "ok") { ok++; wOk++; }
            else if (r?.status === "failed") failed++;
        }
        if (wOk >= runsPerDay) walletsCompleted++;
    }
    return { addresses, ok, failed, walletsCompleted, day, strategy };
}
