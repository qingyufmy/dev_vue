#!/usr/bin/env python3
"""
AURUM AI MT5 Bridge — macOS 版本
说明：MetaTrader5 Python 库仅支持 Windows，macOS 无法直接连接 MT5 终端。

方案 A（推荐）：在 Windows 上运行 aurum_bridge_win.py，Mac 端通过网页控制。
方案 B：Mac 远程连接 Windows 上的桥接服务。

此脚本为方案 B：连接远程桥接服务，转发命令到 Windows MT5。

使用方法:
  pip install requests
  python aurum_bridge_mac.py

配置: 修改下方 BRIDGE_URL（Windows 桥接地址）
"""

import time
import json
import sys
import uuid
import requests

# ============ 配置 ============
BRIDGE_URL = "http://YOUR_WINDOWS_IP:8766"  # Windows 桥接服务地址
AUTH_TOKEN = ""  # 登录 token
POLL_INTERVAL = 3
BRIDGE_ID = str(uuid.uuid4())[:8]
# ==============================

HEADERS = {"Content-Type": "application/json", "Authorization": f"Bearer {AUTH_TOKEN}"}


def forward_to_bridge(action, params=None):
    """转发命令到 Windows 桥接服务"""
    try:
        resp = requests.post(
            f"{BRIDGE_URL}/execute",
            json={"action": action, "params": params or {}},
            timeout=30,
        )
        return resp.json()
    except requests.exceptions.ConnectionError:
        return {"status": "error", "message": f"无法连接桥接服务 {BRIDGE_URL}"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


def handle_command(cmd):
    """处理服务器命令并转发到桥接"""
    action = cmd.get("action")
    params = cmd.get("params", {})
    cmd_id = cmd.get("id")

    if action == "status":
        result = {
            "status": "connected",
            "bridge_id": BRIDGE_ID,
            "platform": "macOS-relay",
            "bridge_url": BRIDGE_URL,
            "downstream": forward_to_bridge("status"),
        }
    elif action == "ping":
        downstream = forward_to_bridge("ping")
        result = {"status": "ok", "bridge_id": BRIDGE_ID, "platform": "macOS-relay", "downstream": downstream}
    else:
        result = forward_to_bridge(action, params)

    if cmd_id:
        SERVER_URL = "http://localhost:3000"
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


def main():
    global AUTH_TOKEN, BRIDGE_URL, SERVER_URL

    if len(sys.argv) >= 4:
        SERVER_URL = sys.argv[1]
        BRIDGE_URL = sys.argv[2]
        AUTH_TOKEN = sys.argv[3]
    elif len(sys.argv) >= 2 and sys.argv[1] == "--help":
        print("用法: python aurum_bridge_mac.py [SERVER_URL] [BRIDGE_URL] [AUTH_TOKEN]")
        print("示例: python aurum_bridge_mac.py http://server:3000 http://win-pc:8766 eyJhbGc...")
        sys.exit(0)

    SERVER_URL = "http://localhost:3000"

    if not AUTH_TOKEN:
        print("[ERROR] 未设置 AUTH_TOKEN")
        print("  python aurum_bridge_mac.py http://server:3000 http://win:8766 YOUR_TOKEN")
        sys.exit(1)

    HEADERS["Authorization"] = f"Bearer {AUTH_TOKEN}"

    print(f"[INFO] macOS 桥接中继启动")
    print(f"[INFO] WSS 服务器: {SERVER_URL}")
    print(f"[INFO] Windows 桥接: {BRIDGE_URL}")
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
                for cmd in data.get("commands", []):
                    print(f"[CMD] {cmd.get('action')} -> ", end="")
                    result = handle_command(cmd)
                    print(f"{result.get('status', '?')}")
            elif resp.status_code == 401:
                print("[ERROR] 认证失败")
                break
        except requests.exceptions.Timeout:
            pass
        except requests.exceptions.ConnectionError:
            print(f"[WARN] 无法连接服务器，{POLL_INTERVAL}s 后重试...")
        except KeyboardInterrupt:
            print("\n[INFO] 用户停止")
            break
        except Exception as e:
            print(f"[ERROR] {e}")

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
