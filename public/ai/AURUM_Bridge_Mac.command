#!/bin/bash
# AURUM AI Bridge - macOS (中继模式)
# 双击 .command 文件即可运行

clear
echo "========================================"
echo "  AURUM AI - MT5 本地桥接服务 (macOS)"
echo "========================================"
echo ""

# ---- Auto-detect Python ----
PYTHON=""
for cmd in python3 python; do
    if command -v "$cmd" &>/dev/null; then
        PYTHON="$cmd"
        break
    fi
done

if [ -z "$PYTHON" ]; then
    echo "[错误] 未找到 Python，请先安装:"
    echo "  brew install python3"
    echo "  或从 https://www.python.org/downloads/ 下载"
    read -p "按回车退出..."
    exit 1
fi

echo "[√] Python: $($PYTHON --version)"

# ---- Install dependencies ----
echo ""
echo "[..] 检查依赖..."
$PYTHON -m pip install --quiet requests 2>/dev/null
if [ $? -ne 0 ]; then
    echo "[..] 正在安装 requests..."
    $PYTHON -m pip install requests
fi
echo "[√] 依赖已就绪"

# ---- Launch ----
echo ""
echo "[→] 启动桥接服务（中继模式）..."
echo "    服务器: {{SERVER_URL}}"
echo "    按 Ctrl+C 停止"
echo ""

$PYTHON << 'PYTHON_SCRIPT'
import requests, json, time, uuid, sys

SERVER = '{{SERVER_URL}}'
TOKEN = '{{TOKEN}}'
POLL_INTERVAL = 2
HEARTBEAT_INTERVAL = 30

class MacBridge:
    def __init__(self):
        self.session_id = 'mac-' + str(uuid.uuid4())[:8]
        self.running = True
        self.windows_bridge = None
        self.last_heartbeat = 0

    def headers(self):
        return {'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json'}

    def report(self, cmd_id, result):
        try:
            requests.post(SERVER + '/aurum-api/bridge/result',
                json={'command_id': cmd_id, 'result': result}, headers=self.headers(), timeout=10)
        except: pass

    def heartbeat(self):
        now = time.time()
        if now - self.last_heartbeat < HEARTBEAT_INTERVAL: return
        self.last_heartbeat = now
        try:
            r = requests.get(SERVER + '/aurum-api/bridge/status', headers=self.headers(), timeout=5)
            status = r.json() if r.status_code == 200 else {}
            requests.post(SERVER + '/aurum-api/bridge/result',
                json={'command_id': '_heartbeat', 'session_id': self.session_id,
                      'result': {'status': 'alive', 'mode': 'mac-relay'}},
                headers=self.headers(), timeout=5)
        except: pass

    def handle_command(self, cmd):
        action = cmd.get('action')
        cmd_id = cmd.get('command_id')
        params = cmd.get('params', {})
        try:
            if action == 'connect':
                result = {'status': 'connected', 'mode': 'mac-relay',
                          'message': 'macOS中继模式 - 交易命令将通过Windows桥接执行'}
            elif action == 'disconnect':
                result = {'status': 'disconnected'}
            elif action == 'status':
                result = {'connected': True, 'mode': 'mac-relay'}
            elif action in ('open', 'close', 'rates', 'quote', 'positions', 'account'):
                # Relay to Windows bridge
                if self.windows_bridge:
                    try:
                        r = requests.post(self.windows_bridge + '/bridge/command',
                            json={'action': action, 'params': params}, timeout=10)
                        result = r.json()
                    except Exception as e:
                        result = {'error': 'Windows桥接不可达: ' + str(e)}
                else:
                    result = {'error': '未配置Windows桥接地址，请在设置中填写'}
            else:
                result = {'error': '未知命令: ' + str(action)}
        except Exception as e:
            result = {'error': str(e)}
        self.report(cmd_id, result)

    def poll_loop(self):
        while self.running:
            try:
                r = requests.get(SERVER + '/aurum-api/bridge/poll', headers=self.headers(), timeout=15)
                if r.status_code == 200:
                    cmds = r.json().get('commands', [])
                    for cmd in cmds: self.handle_command(cmd)
                    self.heartbeat()
                else:
                    time.sleep(5)
            except requests.exceptions.Timeout:
                self.heartbeat()
            except Exception as e:
                print('[!] 连接异常:', e)
                time.sleep(5)

    def run(self):
        print('[√] 桥接会话: ' + self.session_id)
        print('[i] macOS 中继模式 - 需要Windows端先运行桥接服务')
        print('[..] 开始轮询服务器...')
        self.poll_loop()

bridge = MacBridge()
try:
    bridge.run()
except KeyboardInterrupt:
    print('桥接已停止')
PYTHON_SCRIPT

echo ""
echo "桥接服务已停止"
read -p "按回车退出..."
