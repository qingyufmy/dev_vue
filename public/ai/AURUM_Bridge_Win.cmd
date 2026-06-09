<# :
@echo off
title AURUM AI Bridge
powershell -ExecutionPolicy Bypass -File "%~f0" %*
pause
exit /b %errorlevel%
#>

# PowerShell section - writes Python script and runs it
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$server = "{{SERVER_URL}}"
$token = "{{TOKEN}}"

# Auto-detect Python
$python = $null
foreach ($cmd in @("python", "python3")) {
    $p = Get-Command $cmd -ErrorAction SilentlyContinue
    if ($p) { $python = $p.Source; break }
}
if (-not $python) {
    # Check common paths
    foreach ($ver in @("313","312","311","310")) {
        $p = "$env:LOCALAPPDATA\Programs\Python\Python$ver\python.exe"
        if (Test-Path $p) { $python = $p; break }
    }
}
if (-not $python) {
    Write-Host "[ERROR] Python not found. Install from https://www.python.org/downloads/" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host "[OK] Python: $python" -ForegroundColor Green

# Install dependencies
Write-Host "[..] Checking dependencies..." -ForegroundColor Yellow
& $python -m pip install --quiet MetaTrader5 requests 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "[..] Installing packages (first time)..." -ForegroundColor Yellow
    & $python -m pip install MetaTrader5 requests
}
Write-Host "[OK] Dependencies ready" -ForegroundColor Green

# Write Python script
$pyFile = "$env:TEMP\aurum_bridge_win.py"
Write-Host "[..] Writing bridge script..." -ForegroundColor Yellow

$pyCode = @"
import MetaTrader5 as mt5
import requests, time, uuid, sys

SERVER = '$server'
TOKEN = '$token'
POLL_INTERVAL = 2
HEARTBEAT_INTERVAL = 30
SYMBOL = 'XAUUSD.s'

class Bridge:
    def __init__(self):
        self.session_id = 'bridge-' + str(uuid.uuid4())[:8]
        self.connected = False
        self.running = True
        self.account_info = {}
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
            info = mt5.account_info()
            pos = mt5.positions_get()
            self.account_info = {
                'balance': info.balance if info else 0,
                'equity': info.equity if info else 0,
                'margin': info.margin if info else 0,
                'free_margin': info.margin_free if info else 0,
                'profit': info.profit if info else 0,
                'positions': len(pos) if pos else 0,
                'server': info.server if info else '',
                'login': info.login if info else 0,
            }
            requests.post(SERVER + '/aurum-api/bridge/result',
                json={'command_id': '_heartbeat', 'session_id': self.session_id,
                      'result': {'status': 'alive', 'account': self.account_info}},
                headers=self.headers(), timeout=5)
        except:
            pass

    def connect_mt5(self):
        if not mt5.initialize():
            return {'status': 'error', 'message': f'MT5 init failed: {mt5.last_error()}'}
        info = mt5.account_info()
        if not info:
            return {'status': 'error', 'message': 'Cannot get account info'}
        self.connected = True
        return {'status': 'connected', 'login': info.login, 'server': info.server,
                'balance': info.balance, 'equity': info.equity, 'leverage': info.leverage}

    def disconnect_mt5(self):
        mt5.shutdown()
        self.connected = False
        return {'status': 'disconnected'}

    def handle_command(self, cmd):
        action = cmd.get('action')
        cmd_id = cmd.get('command_id')
        params = cmd.get('params', {})
        try:
            if action == 'connect':
                result = self.connect_mt5()
            elif action == 'disconnect':
                result = self.disconnect_mt5()
            elif action == 'status':
                info = mt5.account_info()
                result = {'connected': self.connected, 'account': self.account_info,
                          'terminal': mt5.terminal_info()._asdict() if mt5.terminal_info() else {}}
            elif action == 'open':
                result = self.open_trade(params)
            elif action == 'close':
                result = self.close_trade(params)
            elif action == 'rates':
                result = self.get_rates(params)
            elif action == 'quote':
                tick = mt5.symbol_info_tick(params.get('symbol', SYMBOL))
                result = tick._asdict() if tick else {'error': 'no tick'}
            elif action == 'positions':
                pos = mt5.positions_get()
                result = [p._asdict() for p in pos] if pos else []
            elif action == 'account':
                info = mt5.account_info()
                result = info._asdict() if info else {}
            else:
                result = {'error': f'unknown: {action}'}
        except Exception as e:
            result = {'error': str(e)}
        print(f'[CMD] {action} -> {str(result)[:100]}')
        self.report(cmd_id, result)

    def open_trade(self, p):
        symbol = p.get('symbol', SYMBOL)
        lot = float(p.get('volume', 0.01))
        sl = float(p.get('sl', 0)) or None
        tp = float(p.get('tp', 0)) or None
        comment = p.get('comment', 'AURUM')
        info = mt5.symbol_info(symbol)
        if not info:
            return {'error': f'{symbol} not found'}
        if not info.visible:
            mt5.symbol_select(symbol, True)
        point = info.point
        price = mt5.symbol_info_tick(symbol).ask
        order_type = mt5.ORDER_TYPE_BUY if p.get('direction') in ('buy', 'long') else mt5.ORDER_TYPE_SELL
        req = {'action': mt5.TRADE_ACTION_DEAL, 'symbol': symbol, 'volume': lot,
               'type': order_type, 'price': price, 'deviation': 20, 'magic': 202606,
               'comment': comment, 'type_filling': mt5.ORDER_FILLING_IOC}
        if sl:
            req['sl'] = price - sl * point if order_type == mt5.ORDER_TYPE_BUY else price + sl * point
        if tp:
            req['tp'] = price + tp * point if order_type == mt5.ORDER_TYPE_BUY else price - tp * point
        result = mt5.order_send(req)
        if result.retcode != mt5.TRADE_RETCODE_DONE:
            return {'error': str(result.retcode), 'message': result.comment}
        return {'ticket': result.order, 'price': result.price, 'volume': result.volume}

    def close_trade(self, p):
        ticket = p.get('ticket')
        pos = mt5.positions_get(ticket=ticket)
        if not pos:
            return {'error': 'position not found'}
        pos = pos[0]
        tick = mt5.symbol_info_tick(pos.symbol)
        price = tick.bid if pos.type == 0 else tick.ask
        req = {'action': mt5.TRADE_ACTION_DEAL, 'symbol': pos.symbol, 'volume': pos.volume,
               'type': 1 - pos.type, 'position': ticket, 'price': price,
               'deviation': 20, 'magic': 202606, 'comment': 'AURUM-close',
               'type_filling': mt5.ORDER_FILLING_IOC}
        result = mt5.order_send(req)
        if result.retcode != mt5.TRADE_RETCODE_DONE:
            return {'error': str(result.retcode), 'message': result.comment}
        return {'ticket': result.order, 'profit': pos.profit}

    def get_rates(self, p):
        tf_map = {'M1': 1, 'M5': 5, 'M15': 15, 'H1': 16385, 'H4': 16388, 'D1': 16408}
        tf = tf_map.get(p.get('timeframe', 'H1'), 16385)
        count = min(int(p.get('count', 500)), 5000)
        rates = mt5.copy_rates_from_pos(p.get('symbol', SYMBOL), tf, 0, count)
        if rates is None:
            return []
        return [{'time': int(r[0]), 'open': r[1], 'high': r[2], 'low': r[3], 'close': r[4], 'volume': r[5]} for r in rates]

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
                    print(f'[!] Server returned {r.status_code}')
                    time.sleep(5)
            except requests.exceptions.Timeout:
                self.heartbeat()
            except Exception as e:
                print(f'[!] Error: {e}')
                time.sleep(5)

    def run(self):
        print(f'[OK] Bridge session: {self.session_id}')
        print('[..] Connecting MT5...')
        result = self.connect_mt5()
        print(f'[OK] MT5: {result}')
        print('[..] Polling server...\n')
        self.poll_loop()

if __name__ == '__main__':
    bridge = Bridge()
    try:
        bridge.run()
    except KeyboardInterrupt:
        bridge.disconnect_mt5()
        print('\nBridge stopped.')
    except Exception as e:
        print(f'[FATAL] {e}')
        import traceback; traceback.print_exc()
        input('\nPress Enter to exit...')
"@

[System.IO.File]::WriteAllText($pyFile, $pyCode, [System.Text.Encoding]::UTF8)
Write-Host "[OK] Script ready" -ForegroundColor Green

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Starting bridge..." -ForegroundColor Cyan
Write-Host "  Server: $server" -ForegroundColor Cyan
Write-Host "  Press Ctrl+C to stop" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

& $python $pyFile
Write-Host ""
Write-Host "Bridge stopped." -ForegroundColor Yellow
