#!/bin/bash
# Rho-X 自动交易 daemon 管理脚本
#
# 用法:
#   ./manage.sh start [strategy]    启动 daemon (默认 strategy = config.strategy = "instant")
#   ./manage.sh stop                停止 daemon
#   ./manage.sh restart [strategy]  重启
#   ./manage.sh status              查看状态
#   ./manage.sh logs [N]            tail 日志 (默认 50 行)
#   ./manage.sh tail                tail -f 实时日志
#
# 密码读取顺序:
#   1. 环境变量 RHO_PASSWORD
#   2. 同目录 .env 文件中的 RHO_PASSWORD=...  (建议这个, .gitignore 已挡)
#   3. 没有 → start 命令交互式让你输入

set -e
cd "$(dirname "$0")"

# 颜色
R='\033[0;31m'; G='\033[0;32m'; Y='\033[1;33m'; B='\033[0;34m'; N='\033[0m'
info()    { echo -e "${B}[i]${N} $1"; }
ok()      { echo -e "${G}[ok]${N} $1"; }
warn()    { echo -e "${Y}[!]${N} $1"; }
err()     { echo -e "${R}[x]${N} $1"; }

PID_FILE=".rho-trade.pid"
LOG_DIR="logs"
LOG_FILE="$LOG_DIR/trade.log"
mkdir -p "$LOG_DIR"

is_running() {
    [ -f "$PID_FILE" ] || return 1
    local pid=$(cat "$PID_FILE")
    if ps -p "$pid" > /dev/null 2>&1; then return 0; fi
    rm -f "$PID_FILE"
    return 1
}

# 取密码: env > .env > 交互式输入
load_password() {
    if [ -n "$RHO_PASSWORD" ]; then
        info "密码: 来自 RHO_PASSWORD env"
        return 0
    fi
    if [ -f ".env" ] && grep -q "^RHO_PASSWORD=" ".env"; then
        # 只读 RHO_PASSWORD 行, 不污染其他 env
        export RHO_PASSWORD=$(grep "^RHO_PASSWORD=" ".env" | head -1 | cut -d'=' -f2- | sed 's/^"//;s/"$//')
        if [ -n "$RHO_PASSWORD" ]; then
            info "密码: 来自 .env 文件"
            return 0
        fi
    fi
    # 交互式
    read -s -p "请输入解密密码: " RHO_PASSWORD
    echo
    if [ -z "$RHO_PASSWORD" ]; then
        err "密码不能为空"
        exit 1
    fi
    export RHO_PASSWORD
}

cmd_start() {
    if is_running; then
        warn "daemon 已在运行 (pid=$(cat $PID_FILE))"
        exit 1
    fi
    local strategy="${1:-}"

    load_password

    info "启动 daemon, 策略=${strategy:-default(config)} 日志=$LOG_FILE"
    # nohup 后台跑, RHO_PASSWORD 从当前 env 继承
    nohup node trade.mjs $strategy --daemon >> "$LOG_FILE" 2>&1 &
    local pid=$!
    echo "$pid" > "$PID_FILE"

    # 等几秒确认进程没立即退出
    sleep 2
    if is_running; then
        ok "daemon 已启动 pid=$pid"
        info "查日志: ./manage.sh logs   或   ./manage.sh tail"
    else
        err "daemon 启动失败, 看日志: tail -50 $LOG_FILE"
        exit 1
    fi
}

cmd_stop() {
    if ! is_running; then
        warn "daemon 没在跑"
        exit 0
    fi
    local pid=$(cat "$PID_FILE")
    info "发送 SIGTERM 给 pid=$pid (优雅退出, 等当前 cycle 完成) ..."
    kill -TERM "$pid"

    # 最多等 5 分钟 (策略可能在跑)
    local count=0
    while ps -p "$pid" > /dev/null 2>&1; do
        sleep 2
        count=$((count + 2))
        if [ $count -ge 300 ]; then
            err "5 分钟还没退出, 强杀 SIGKILL"
            kill -KILL "$pid" 2>/dev/null || true
            break
        fi
        if [ $((count % 20)) -eq 0 ]; then
            info "已等 ${count}s, 仍在跑 ..."
        fi
    done
    rm -f "$PID_FILE"
    ok "daemon 已停止"
}

cmd_status() {
    if is_running; then
        local pid=$(cat "$PID_FILE")
        ok "daemon 运行中 pid=$pid"
        ps -p "$pid" -o pid,etime,rss,command 2>/dev/null | tail -1
    else
        warn "daemon 没在跑"
    fi
    if [ -f "state.json" ]; then
        local size=$(wc -c < state.json | awk '{print $1}')
        info "state.json 存在 (${size} 字节)"
    fi
    if [ -f "$LOG_FILE" ]; then
        local lines=$(wc -l < "$LOG_FILE" | awk '{print $1}')
        info "$LOG_FILE 共 ${lines} 行"
    fi
}

cmd_logs() {
    local n="${1:-50}"
    if [ ! -f "$LOG_FILE" ]; then
        warn "$LOG_FILE 不存在"
        exit 0
    fi
    tail -n "$n" "$LOG_FILE"
}

cmd_tail() {
    if [ ! -f "$LOG_FILE" ]; then
        warn "$LOG_FILE 不存在, 等 daemon 启动"
        exit 0
    fi
    tail -f "$LOG_FILE"
}

case "${1:-}" in
    start)   cmd_start "$2" ;;
    stop)    cmd_stop ;;
    restart) cmd_stop; cmd_start "$2" ;;
    status)  cmd_status ;;
    logs)    cmd_logs "$2" ;;
    tail|f)  cmd_tail ;;
    *)
        cat <<EOF
用法: $0 {start|stop|restart|status|logs|tail} [strategy]

  start [strategy]    启动 daemon (后台, 写日志到 $LOG_FILE)
  stop                优雅停止 (等当前 cycle 完成, 最多 5 分钟)
  restart [strategy]  stop + start
  status              看运行中状态 + state.json/log 概况
  logs [N]            tail 最近 N 行日志 (默认 50)
  tail                tail -f 实时跟随日志

策略可选: instant (默认) | balance

密码:
  优先 RHO_PASSWORD env > .env 文件 > 交互式 read

示例:
  ./manage.sh start instant       启动 instant 策略 daemon
  ./manage.sh start               用 config.strategy 默认值启动
  ./manage.sh status
  ./manage.sh tail
  ./manage.sh stop
EOF
        exit 1
        ;;
esac
