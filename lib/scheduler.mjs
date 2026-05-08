// 简化版调度: 每天固定时刻 + jitter, 启动若今日未跑则立即补跑

const sleep = ms => new Promise(r => setTimeout(r, ms));

export function createShutdownSignal() {
    const state = { requested: false, reason: null };
    const handlers = [];
    const handle = sig => () => {
        if (state.requested) return;
        state.requested = true;
        state.reason = sig;
        console.log(`\n[shutdown] 收到 ${sig}, 等待当前 cycle 完成 ...`);
        handlers.forEach(fn => { try { fn(sig); } catch {} });
    };
    process.once("SIGINT", handle("SIGINT"));
    process.once("SIGTERM", handle("SIGTERM"));
    return {
        get requested() { return state.requested; },
        get reason() { return state.reason; },
        onSignal: fn => handlers.push(fn),
    };
}

// 计算下次触发: 今天 hour:minute 已过 -> 明天; 加 0..jitterMin 随机
export function computeNextRun(now, hour, minute, jitterMin) {
    const next = new Date(now);
    next.setHours(hour, minute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    if (jitterMin > 0) {
        const jitter = Math.floor(Math.random() * (jitterMin + 1));
        next.setMinutes(next.getMinutes() + jitter);
    }
    return next;
}

// 等到指定时刻, 但每 pollMs 检查一次 shutdown
export async function sleepUntil(when, pollMs, shutdown) {
    while (Date.now() < when.getTime()) {
        if (shutdown?.requested) return;
        const remaining = when.getTime() - Date.now();
        await sleep(Math.min(pollMs, remaining));
    }
}

export function fmtDuration(ms) {
    if (ms < 0) ms = 0;
    const s = Math.round(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${h}h${m}m${sec}s`;
}
