import fs from "fs";

// state.json 结构:
// {
//   "<address-lowercase>": {
//     "address": "<原 case>",
//     "runs": {
//       "YYYY-MM-DD": {
//         "instant": { strategy, status, ts, ... },
//         "balance": { strategy, status, ts, sessionId, ... },
//       }
//     }
//   }
// }

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

export function getRun(state, address, day, strategy) {
    return state[recordKey(address)]?.runs?.[day]?.[strategy];
}

export function setRun(state, address, day, strategy, record) {
    const k = recordKey(address);
    if (!state[k]) state[k] = { address, runs: {} };
    if (!state[k].runs) state[k].runs = {};
    if (!state[k].runs[day]) state[k].runs[day] = {};
    state[k].runs[day][strategy] = record;
}

export function summary(state, day, strategy) {
    let ok = 0, failed = 0, addresses = 0;
    for (const entry of Object.values(state)) {
        addresses++;
        const r = entry.runs?.[day]?.[strategy];
        if (!r) continue;
        if (r.status === "ok") ok++;
        else if (r.status === "failed") failed++;
    }
    return { addresses, ok, failed, day, strategy };
}
