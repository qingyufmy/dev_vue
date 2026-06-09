#!/usr/bin/env python3
"""
AURUM AI MT5 Bridge — Windows 本地桥接脚本
连接本地 MT5 终端，轮询 WSS 服务器执行交易命令

使用方法:
  pip install MetaTrader5 requests
  python aurum_bridge_win.py

配置: 修改下方 SERVER_URL 和 AUTH_TOKEN
"""

import time
import json
import sys
import os
import uuid
import MetaTrader5 as mt5
import requests

# ============ 配置 ============
SERVER_URL = "http://localhost:3000"  # WSS 服务器地址
AUTH_TOKEN = ""  # 你的登录 token（从页面自动填充）
POLL_INTERVAL = 3  # 轮询间隔（秒）
BRIDGE_ID = str(uuid.uuid4())[:8]  # 本机唯一标识
# ==============================

HEADERS = {"Content-Type": "application/json", "Authorization": f"Bearer {AUTH_TOKEN}"}
MT5_CONNECTED = False


def mt5_init():
    """初始化 MT5 连接"""
    global MT5_CONNECTED
    if not mt5.initialize():
        print(f"[ERROR] MT5 初始化失败: {mt5.last_error()}")
        return False
    info = mt5.account_info()
    if info is None:
        print(f"[ERROR] 获取账户信息失败: {mt5.last_error()}")
        mt5.shutdown()
        return False
    MT5_CONNECTED = True
    print(f"[OK] MT5 已连接: {info.server} | {info.login} | ${info.balance:.2f}")
    return True


def mt5_get_rates(symbol, timeframe_str, count=100):
    """获取 K 线数据"""
    tf_map = {
        "M1": mt5.TIMEFRAME_M1, "M5": mt5.TIMEFRAME_M5,
        "M15": mt5.TIMEFRAME_M15, "M30": mt5.TIMEFRAME_M30,
        "H1": mt5.TIMEFRAME_H1, "H4": mt5.TIMEFRAME_H4,
        "D1": mt5.TIMEFRAME_D1,
    }
    tf = tf_map.get(timeframe_str.upper())
    if tf is None:
        return None
    rates = mt5.copy_rates_from_pos(symbol, tf, 0, count)
    if rates is None:
        return None
    result = []
    for r in rates:
        result.append({
            "time": int(r["time"]),
            "open": r["open"],
            "high": r["high"],
            "low": r["low"],
            "close": r["close"],
            "tick_volume": int(r["tick_volume"]),
            "spread": int(r["spread"]),
        })
    return result


def mt5_get_quote(symbol):
    """获取实时报价"""
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return None
    return {"bid": tick.bid, "ask": tick.ask, "time": int(tick.time)}


def mt5_get_positions():
    """获取当前持仓"""
    positions = mt5.positions_get()
    if positions is None:
        return []
    result = []
    for p in positions:
        result.append({
            "ticket": p.ticket,
            "symbol": p.symbol,
            "type": "buy" if p.type == mt5.ORDER_TYPE_BUY else "sell",
            "volume": p.volume,
            "price_open": p.price_open,
            "price_current": p.price_current,
            "sl": p.sl,
            "tp": p.tp,
            "profit": p.profit,
            "time": int(p.time),
            "magic": p.magic,
            "comment": p.comment,
        })
    return result


def mt5_get_account():
    """获取账户信息"""
    info = mt5.account_info()
    if info is None:
        return None
    return {
        "login": info.login,
        "server": info.server,
        "balance": info.balance,
        "equity": info.equity,
        "margin": info.margin,
        "free_margin": info.margin_free,
        "leverage": info.leverage,
        "currency": info.currency,
        "name": info.name,
    }


def mt5_open_order(symbol, order_type, volume, sl=0.0, tp=0.0, comment=""):
    """开仓"""
    info = mt5.symbol_info(symbol)
    if info is None:
        return {"status": "error", "message": f"品种 {symbol} 不存在"}
    if not info.visible:
        mt5.symbol_select(symbol, True)

    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return {"status": "error", "message": f"获取 {symbol} 报价失败"}

    price = tick.ask if order_type == "buy" else tick.bid
    mt5_type = mt5.ORDER_TYPE_BUY if order_type == "buy" else mt5.ORDER_TYPE_SELL

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": float(volume),
        "type": mt5_type,
        "price": price,
        "sl": float(sl),
        "tp": float(tp),
        "deviation": 20,
        "magic": 202606,
        "comment": comment or "AURUM AI",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }

    result = mt5.order_send(request)
    if result is None:
        return {"status": "error", "message": f"order_send 返回 None: {mt5.last_error()}"}
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return {"status": "error", "message": f"交易失败: {result.comment} (code={result.retcode})"}

    return {
        "status": "success",
        "ticket": result.order,
        "price": result.price,
        "volume": result.volume,
        "comment": result.comment,
    }


def mt5_close_position(ticket):
    """平仓"""
    position = mt5.positions_get(ticket=ticket)
    if not position:
        return {"status": "error", "message": f"持仓 {ticket} 不存在"}

    pos = position[0]
    symbol = pos.symbol
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return {"status": "error", "message": f"获取 {symbol} 报价失败"}

    close_type = mt5.ORDER_TYPE_SELL if pos.type == mt5.ORDER_TYPE_BUY else mt5.ORDER_TYPE_BUY
    price = tick.bid if pos.type == mt5.ORDER_TYPE_BUY else tick.ask

    request = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": pos.volume,
        "type": close_type,
        "position": ticket,
        "price": price,
        "deviation": 20,
        "magic": 202606,
        "comment": "AURUM AI Close",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": mt5.ORDER_FILLING_IOC,
    }

    result = mt5.order_send(request)
    if result is None:
        return {"status": "error", "message": f"平仓失败: {mt5.last_error()}"}
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return {"status": "error", "message": f"平仓失败: {result.comment} (code={result.retcode})"}

    return {"status": "success", "ticket": ticket, "comment": "已平仓"}


def handle_command(cmd):
    """处理服务器下发的命令"""
    action = cmd.get("action")
    params = cmd.get("params", {})
    cmd_id = cmd.get("id")

    try:
        if action == "status":
            result = {
                "status": "connected",
                "bridge_id": BRIDGE_ID,
                "mt5_connected": MT5_CONNECTED,
                "account": mt5_get_account(),
                "positions": mt5_get_positions(),
            }
        elif action == "rates":
            rates = mt5_get_rates(params["symbol"], params["timeframe"], params.get("count", 100))
            result = {"status": "ok", "rates": rates} if rates else {"status": "error", "message": "获取K线失败"}
        elif action == "quote":
            quote = mt5_get_quote(params["symbol"])
            result = {"status": "ok", "quote": quote} if quote else {"status": "error", "message": "获取报价失败"}
        elif action == "positions":
            result = {"status": "ok", "positions": mt5_get_positions()}
        elif action == "account":
            result = {"status": "ok", "account": mt5_get_account()}
        elif action == "open":
            result = mt5_open_order(
                params["symbol"], params["type"], params["volume"],
                params.get("sl", 0), params.get("tp", 0), params.get("comment", ""),
            )
        elif action == "close":
            result = mt5_close_position(params["ticket"])
        elif action == "ping":
            result = {"status": "ok", "bridge_id": BRIDGE_ID}
        else:
            result = {"status": "error", "message": f"未知命令: {action}"}
    except Exception as e:
        result = {"status": "error", "message": str(e)}

    # 回报结果
    if cmd_id:
        try:
            requests.post(
                f"{SERVER_URL}/api/bridge/result",
                json={"command_id": cmd_id, "result": result},
                headers=HEADERS,
                timeout=10,
            )
        except Exception as e:
            print(f"[WARN] 回报失败: {e}")

    return result


def poll_loop():
    """主轮询循环"""
    print(f"[INFO] 开始轮询 {SERVER_URL} (间隔 {POLL_INTERVAL}s)")
    print(f"[INFO] Bridge ID: {BRIDGE_ID}")
    print(f"[INFO] 按 Ctrl+C 停止\n")

    while True:
        try:
            resp = requests.get(
                f"{SERVER_URL}/api/bridge/poll",
                headers=HEADERS,
                timeout=POLL_INTERVAL + 5,
            )
            if resp.status_code == 200:
                data = resp.json()
                commands = data.get("commands", [])
                for cmd in commands:
                    print(f"[CMD] {cmd.get('action')} -> ", end="")
                    result = handle_command(cmd)
                    print(f"{result.get('status', '?')}")
            elif resp.status_code == 401:
                print("[ERROR] 认证失败，请检查 AUTH_TOKEN")
                break
            else:
                print(f"[WARN] 服务器返回 {resp.status_code}")
        except requests.exceptions.Timeout:
            pass  # 正常超时，继续轮询
        except requests.exceptions.ConnectionError:
            print(f"[WARN] 无法连接服务器，{POLL_INTERVAL}s 后重试...")
        except KeyboardInterrupt:
            print("\n[INFO] 用户停止")
            break
        except Exception as e:
            print(f"[ERROR] {e}")

        time.sleep(POLL_INTERVAL)


def main():
    global AUTH_TOKEN, SERVER_URL

    # 支持命令行参数
    if len(sys.argv) >= 3:
        SERVER_URL = sys.argv[1]
        AUTH_TOKEN = sys.argv[2]
    elif len(sys.argv) >= 2 and sys.argv[1] == "--help":
        print("用法: python aurum_bridge_win.py [SERVER_URL] [AUTH_TOKEN]")
        print("示例: python aurum_bridge_win.py http://your-server.com:3000 eyJhbGc...")
        sys.exit(0)

    if not AUTH_TOKEN:
        print("[ERROR] 未设置 AUTH_TOKEN，请在脚本中配置或通过命令行传入")
        print("  python aurum_bridge_win.py http://localhost:3000 YOUR_TOKEN")
        sys.exit(1)

    HEADERS["Authorization"] = f"Bearer {AUTH_TOKEN}"

    if not mt5_init():
        print("[ERROR] 无法连接 MT5，请确保 MetaTrader 5 已启动")
        sys.exit(1)

    try:
        poll_loop()
    finally:
        mt5.shutdown()
        print("[INFO] MT5 已断开")


if __name__ == "__main__":
    main()
