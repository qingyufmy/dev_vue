#!/bin/bash
# AURUM AI Bridge - macOS (Relay Mode)
# Double-click to run

clear
echo "========================================"
echo "  AURUM AI - MT5 Bridge (macOS Relay)"
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
    echo "[ERROR] Python not found."
    echo "  Install: brew install python3"
    echo "  Or download: https://www.python.org/downloads/"
    echo ""
    read -p "Press Enter to exit..."
    exit 1
fi

echo "[OK] Python: $($PYTHON --version)"
echo ""

# ---- Install dependencies ----
echo "[..] Checking dependencies..."
$PYTHON -m pip install --quiet requests 2>/dev/null
if [ $? -ne 0 ]; then
    echo "[..] Installing requests (first time)..."
    $PYTHON -m pip install requests
fi
echo "[OK] Dependencies ready"
echo ""

# ---- Write temp Python script ----
PYFILE="/tmp/aurum_bridge_mac.py"
echo "[..] Writing bridge script..."

cat > "$PYFILE" << 'PYEOF'
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
        except Exception as e:
            print('[!] Report failed:', e)

    def heartbeat(self):
        now = time.time()
        if now - self.last_heartbeat < HEARTBEAT_INTERVAL:
            return
        self.last_heartbeat = now
        try:
            requests.post(SERVER + '/aurum-api/bridge/result',
                json={'command_id': '_heartbeat', 'session_id': self.session_id,
                      'result': {'status': 'alive', 'mode': 'mac-relay'}},
                headers=self.headers(), timeout=5)
        except:
            pass

    def handle_command(self, cmd):
        action = cmd.get('action')
        cmd_id = cmd.get('command_id')
        params = cmd.get('params', {})
        try:
            if action == 'connect':
                result = {'status': 'connected', 'mode': 'mac-relay',
                          'message': 'macOS relay - trades forwarded to Windows bridge'}
            elif action == 'disconnect':
                result = {'status': 'disconnected'}
            elif action == 'status':
                result = {'connected': True, 'mode': 'mac-relay'}
            elif action in ('open', 'close', 'rates', 'quote', 'positions', 'account'):
                if self.windows_bridge:
                    try:
                        r = requests.post(self.windows_bridge + '/bridge/command',
                            json={'action': action, 'params': params}, timeout=10)
                        result = r.json()
                    except Exception as e:
                        result = {'error': 'Windows bridge unreachable: ' + str(e)}
                else:
                    result = {'error': 'Windows bridge URL not configured'}
            else:
                result = {'error': 'unknown: ' + str(action)}
        except Exception as e:
            result = {'error': str(e)}
        print('[CMD] ' + str(action) + ' -> ' + str(result)[:80])
        self.report(cmd_id, result)

    def poll_loop(self):
        while self.running:
            try:
                r = requests.get(SERVER + '/aurum-api/bridge/poll', headers=self.headers(), timeout=15)
                if r.status_code == 200:
                    cmds = r.json().get('commands', [])
                    for cmd in cmds:
                        self.handle_command(cmd)
                    self.heartbeat()
                else:
                    print('[!] Server returned', r.status_code)
                    time.sleep(5)
            except requests.exceptions.Timeout:
                self.heartbeat()
            except Exception as e:
                print('[!] Connection error:', e)
                time.sleep(5)

    def run(self):
        print('[OK] Bridge session: ' + self.session_id)
        print('[i] macOS relay mode - trades forwarded to Windows bridge')
        print('[..] Polling server...')
        print('')
        self.poll_loop()

bridge = MacBridge()
try:
    bridge.run()
except KeyboardInterrupt:
    print('')
    print('Bridge stopped.')
except Exception as e:
    print('[FATAL] ' + str(e))
    import traceback; traceback.print_exc()
finally:
    print('')
    input('Press Enter to exit...')
PYEOF

echo "[OK] Script written"
echo ""
echo "========================================"
echo "  Starting bridge..."
echo "  Server: {{SERVER_URL}}"
echo "  Press Ctrl+C to stop"
echo "========================================"
echo ""

$PYTHON "$PYFILE"

echo ""
echo "Bridge stopped."
read -p "Press Enter to exit..."
