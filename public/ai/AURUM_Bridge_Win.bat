@echo off
chcp 65001 >nul 2>&1
title AURUM AI Bridge - Windows
echo.
echo  ========================================
echo   AURUM AI - MT5 Local Bridge Service
echo  ========================================
echo.

:: ---- Auto-detect Python ----
set "PYTHON="
where python >nul 2>&1
if %errorlevel% equ 0 (
    set "PYTHON=python"
    goto :found
)
where python3 >nul 2>&1
if %errorlevel% equ 0 (
    set "PYTHON=python3"
    goto :found
)
for %%P in (
    "%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
    "%LOCALAPPDATA%\Programs\Python\Python310\python.exe"
    "C:\Python313\python.exe"
    "C:\Python312\python.exe"
    "C:\Python311\python.exe"
) do (
    if exist %%P (
        set "PYTHON=%%~P"
        goto :found
    )
)
echo [ERROR] Python not found. Please install Python 3.10+
echo Download: https://www.python.org/downloads/
echo Check "Add Python to PATH" during install.
echo.
pause
exit /b 1

:found
echo [OK] Python: %PYTHON%
%PYTHON% --version
echo.

:: ---- Install dependencies ----
echo [..] Checking dependencies...
%PYTHON% -m pip install --quiet MetaTrader5 requests 2>nul
if %errorlevel% neq 0 (
    echo [..] Installing packages (first time, please wait)...
    %PYTHON% -m pip install MetaTrader5 requests
    if %errorlevel% neq 0 (
        echo [ERROR] Install failed. Run manually: pip install MetaTrader5 requests
        pause
        exit /b 1
    )
)
echo [OK] Dependencies ready
echo.

:: ---- Write temp Python script ----
set "PYFILE=%TEMP%\aurum_bridge.py"
echo [..] Writing bridge script...

(
echo import MetaTrader5 as mt5
echo import requests, json, time, uuid, sys, os
echo.
echo SERVER = '{{SERVER_URL}}'
echo TOKEN = '{{TOKEN}}'
echo POLL_INTERVAL = 2
echo HEARTBEAT_INTERVAL = 30
echo SYMBOL = 'XAUUSD.s'
echo.
echo class Bridge:
echo     def __init__(self):
echo         self.session_id = 'bridge-' + str(uuid.uuid4())[:8]
echo         self.connected = False
echo         self.running = True
echo         self.account_info = {}
echo         self.last_heartbeat = 0
echo.
echo     def headers(self):
echo         return {'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json'}
echo.
echo     def report(self, cmd_id, result):
echo         try:
echo             requests.post(SERVER + '/aurum-api/bridge/result',
echo                 json={'command_id': cmd_id, 'result': result}, headers=self.headers(), timeout=10)
echo         except Exception as e:
echo             print('[!] Report failed:', e)
echo.
echo     def heartbeat(self):
echo         now = time.time()
echo         if now - self.last_heartbeat ^< HEARTBEAT_INTERVAL:
echo             return
echo         self.last_heartbeat = now
echo         try:
echo             info = mt5.account_info()
echo             pos = mt5.positions_get()
echo             self.account_info = {
echo                 'balance': info.balance if info else 0,
echo                 'equity': info.equity if info else 0,
echo                 'margin': info.margin if info else 0,
echo                 'free_margin': info.margin_free if info else 0,
echo                 'profit': info.profit if info else 0,
echo                 'positions': len(pos) if pos else 0,
echo                 'server': info.server if info else '',
echo                 'login': info.login if info else 0,
echo             }
echo             requests.post(SERVER + '/aurum-api/bridge/result',
echo                 json={'command_id': '_heartbeat', 'session_id': self.session_id,
echo                       'result': {'status': 'alive', 'account': self.account_info}},
echo                 headers=self.headers(), timeout=5)
echo         except:
echo             pass
echo.
echo     def connect_mt5(self):
echo         if not mt5.initialize():
echo             return {'status': 'error', 'message': 'MT5 init failed: ' + str(mt5.last_error())}
echo         info = mt5.account_info()
echo         if not info:
echo             return {'status': 'error', 'message': 'Cannot get account info'}
echo         self.connected = True
echo         return {'status': 'connected', 'login': info.login, 'server': info.server,
echo                 'balance': info.balance, 'equity': info.equity, 'leverage': info.leverage}
echo.
echo     def disconnect_mt5(self):
echo         mt5.shutdown()
echo         self.connected = False
echo         return {'status': 'disconnected'}
echo.
echo     def handle_command(self, cmd):
echo         action = cmd.get('action')
echo         cmd_id = cmd.get('command_id')
echo         params = cmd.get('params', {})
echo         try:
echo             if action == 'connect':
echo                 result = self.connect_mt5()
echo             elif action == 'disconnect':
echo                 result = self.disconnect_mt5()
echo             elif action == 'status':
echo                 info = mt5.account_info()
echo                 result = {'connected': self.connected, 'account': self.account_info,
echo                           'terminal': mt5.terminal_info()._asdict() if mt5.terminal_info() else {}}
echo             elif action == 'open':
echo                 result = self.open_trade(params)
echo             elif action == 'close':
echo                 result = self.close_trade(params)
echo             elif action == 'rates':
echo                 result = self.get_rates(params)
echo             elif action == 'quote':
echo                 tick = mt5.symbol_info_tick(params.get('symbol', SYMBOL))
echo                 result = tick._asdict() if tick else {'error': 'no tick'}
echo             elif action == 'positions':
echo                 pos = mt5.positions_get()
echo                 result = [p._asdict() for p in pos] if pos else []
echo             elif action == 'account':
echo                 info = mt5.account_info()
echo                 result = info._asdict() if info else {}
echo             else:
echo                 result = {'error': 'unknown: ' + str(action)}
echo         except Exception as e:
echo             result = {'error': str(e)}
echo         print('[CMD] ' + str(action) + ' -> ' + str(result)[:100])
echo         self.report(cmd_id, result)
echo.
echo     def open_trade(self, p):
echo         symbol = p.get('symbol', SYMBOL)
echo         lot = float(p.get('volume', 0.01))
echo         sl = float(p.get('sl', 0)) or None
echo         tp = float(p.get('tp', 0)) or None
echo         comment = p.get('comment', 'AURUM')
echo         info = mt5.symbol_info(symbol)
echo         if not info:
echo             return {'error': symbol + ' not found'}
echo         if not info.visible:
echo             mt5.symbol_select(symbol, True)
echo         point = info.point
echo         price = mt5.symbol_info_tick(symbol).ask
echo         order_type = mt5.ORDER_TYPE_BUY if p.get('direction') in ('buy', 'long') else mt5.ORDER_TYPE_SELL
echo         req = {'action': mt5.TRADE_ACTION_DEAL, 'symbol': symbol, 'volume': lot,
echo                'type': order_type, 'price': price, 'deviation': 20, 'magic': 202606,
echo                'comment': comment, 'type_filling': mt5.ORDER_FILLING_IOC}
echo         if sl:
echo             req['sl'] = price - sl * point if order_type == mt5.ORDER_TYPE_BUY else price + sl * point
echo         if tp:
echo             req['tp'] = price + tp * point if order_type == mt5.ORDER_TYPE_BUY else price - tp * point
echo         result = mt5.order_send(req)
echo         if result.retcode != mt5.TRADE_RETCODE_DONE:
echo             return {'error': str(result.retcode), 'message': result.comment}
echo         return {'ticket': result.order, 'price': result.price, 'volume': result.volume}
echo.
echo     def close_trade(self, p):
echo         ticket = p.get('ticket')
echo         pos = mt5.positions_get(ticket=ticket)
echo         if not pos:
echo             return {'error': 'position not found'}
echo         pos = pos[0]
echo         tick = mt5.symbol_info_tick(pos.symbol)
echo         price = tick.bid if pos.type == 0 else tick.ask
echo         req = {'action': mt5.TRADE_ACTION_DEAL, 'symbol': pos.symbol, 'volume': pos.volume,
echo                'type': 1 - pos.type, 'position': ticket, 'price': price,
echo                'deviation': 20, 'magic': 202606, 'comment': 'AURUM-close',
echo                'type_filling': mt5.ORDER_FILLING_IOC}
echo         result = mt5.order_send(req)
echo         if result.retcode != mt5.TRADE_RETCODE_DONE:
echo             return {'error': str(result.retcode), 'message': result.comment}
echo         return {'ticket': result.order, 'profit': pos.profit}
echo.
echo     def get_rates(self, p):
echo         tf_map = {'M1': 1, 'M5': 5, 'M15': 15, 'H1': 16385, 'H4': 16388, 'D1': 16408}
echo         tf = tf_map.get(p.get('timeframe', 'H1'), 16385)
echo         count = min(int(p.get('count', 500)), 5000)
echo         rates = mt5.copy_rates_from_pos(p.get('symbol', SYMBOL), tf, 0, count)
echo         if rates is None:
echo             return []
echo         return [{'time': int(r[0]), 'open': r[1], 'high': r[2], 'low': r[3], 'close': r[4], 'volume': r[5]} for r in rates]
echo.
echo     def poll_loop(self):
echo         while self.running:
echo             try:
echo                 r = requests.get(SERVER + '/aurum-api/bridge/poll', headers=self.headers(), timeout=15)
echo                 if r.status_code == 200:
echo                     cmds = r.json().get('commands', [])
echo                     for cmd in cmds:
echo                         self.handle_command(cmd)
echo                     self.heartbeat()
echo                 else:
echo                     print('[!] Server returned', r.status_code)
echo                     time.sleep(5)
echo             except requests.exceptions.Timeout:
echo                 self.heartbeat()
echo             except Exception as e:
echo                 print('[!] Connection error:', e)
echo                 time.sleep(5)
echo.
echo     def run(self):
echo         print('[OK] Bridge session: ' + self.session_id)
echo         print('[..] Connecting MT5...')
echo         result = self.connect_mt5()
echo         print('[OK] MT5: ' + str(result))
echo         print('[..] Polling server...')
echo         print('')
echo         self.poll_loop()
echo.
echo bridge = Bridge()
echo try:
echo     bridge.run()
echo except KeyboardInterrupt:
echo     bridge.disconnect_mt5()
echo     print('Bridge stopped.')
echo except Exception as e:
echo     print('[FATAL] ' + str(e))
echo     import traceback; traceback.print_exc()
echo finally:
echo     print('')
echo     input('Press Enter to exit...')
) > "%PYFILE%"

echo [OK] Script written to %PYFILE%
echo.
echo  ========================================
echo   Starting bridge...
echo   Server: {{SERVER_URL}}
echo   Press Ctrl+C to stop
echo  ========================================
echo.

%PYTHON% "%PYFILE%"
echo.
echo Bridge stopped.
pause
