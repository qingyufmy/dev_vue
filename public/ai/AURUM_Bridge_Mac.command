#!/bin/bash
# AURUM AI Bridge - macOS (Relay Mode)
# Double-click to run

clear
echo "========================================"
echo "  AURUM AI - MT5 Bridge (macOS Relay)"
echo "========================================"
echo ""

# Auto-detect Python
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
    read -p "Press Enter to exit..."
    exit 1
fi

echo "[OK] Python: $($PYTHON --version)"
echo "[..] Checking dependencies..."
$PYTHON -m pip install --quiet requests 2>/dev/null
echo "[OK] Dependencies ready"
echo ""

# Write Python script to temp
PYFILE="/tmp/aurum_bridge_mac.py"
cat > "$PYFILE" << 'PYEOF'
import requests, time, uuid, sys

SERVER = '{{SERVER_URL}}'
TOKEN = '{{TOKEN}}'
POLL_INTERVAL = 2
HEARTBEAT_INTERVAL = 30

class MacBridge:
    def __init__(self):
        self.session_id = 'mac-' + str(uuid.uuid4())[:8]
        self.running = True
        self.last_heartbeat = 0

    def headers(self):
        return {'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json'}

    def report(self, cmd_id, result):
        try:
            requests.post(SERVER + '/aurum-api/bridge/result',
                json={'command_id': cmd_id, 'result': result}, headers=self.headers(), timeout=10)
        except Exception as e:
            print(f'[!] Report failed: {e}')

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
                result = {'status': 'connected', 'mode': 'mac-relay'}
            elif action == 'disconnect':
                result = {'status': 'disconnected'}
            elif action == 'status':
                result = {'connected': True, 'mode': 'mac-relay'}
            elif action in ('open', 'close', 'rates', 'quote', 'positions', 'account'):
                result = {'error': 'macOS relay - run Windows bridge for trading'}
            else:
                result = {'error': f'unknown: {action}'}
        except Exception as e:
            result = {'error': str(e)}
        print(f'[CMD] {action} -> {str(result)[:80]}')
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
                    time.sleep(5)
            except requests.exceptions.Timeout:
                self.heartbeat()
            except Exception as e:
                print(f'[!] Error: {e}')
                time.sleep(5)

    def run(self):
        print(f'[OK] Bridge session: {self.session_id}')
        print('[i] macOS relay mode')
        print('[..] Polling server...\n')
        self.poll_loop()

if __name__ == '__main__':
    bridge = MacBridge()
    try:
        bridge.run()
    except KeyboardInterrupt:
        print('\nBridge stopped.')
    except Exception as e:
        print(f'[FATAL] {e}')
        import traceback; traceback.print_exc()
        input('\nPress Enter to exit...')
PYEOF

echo "[OK] Script ready"
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
