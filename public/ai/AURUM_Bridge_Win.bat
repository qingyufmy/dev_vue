@echo off
chcp 65001 >nul 2>&1
title AURUM AI Bridge - Windows
echo.
echo  ========================================
echo   AURUM AI - MT5 本地桥接服务
echo  ========================================
echo.

:: ---- Auto-detect Python ----
where python >nul 2>&1
if %errorlevel% equ 0 (
    set "PYTHON=python"
    goto :found_python
)
where python3 >nul 2>&1
if %errorlevel% equ 0 (
    set "PYTHON=python3"
    goto :found_python
)
:: Check common install paths
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
        goto :found_python
)
)
echo [错误] 未找到 Python，请先安装 Python 3.10+
echo 下载地址: https://www.python.org/downloads/
echo 安装时请勾选 "Add Python to PATH"
pause
exit /b 1

:found_python
echo [√] Python: %PYTHON%
%PYTHON% --version

:: ---- Install dependencies ----
echo.
echo [..] 检查依赖...
%PYTHON% -m pip install --quiet MetaTrader5 requests 2>nul
if %errorlevel% neq 0 (
    echo [..] 正在安装依赖（首次运行需要，请稍候）...
    %PYTHON% -m pip install MetaTrader5 requests
    if %errorlevel% neq 0 (
        echo [错误] 依赖安装失败，请手动运行: pip install MetaTrader5 requests
        pause
        exit /b 1
    )
)
echo [√] 依赖已就绪

:: ---- Launch ----
echo.
echo [→] 启动桥接服务...
echo     服务器: {{SERVER_URL}}
echo     按 Ctrl+C 停止
echo.
%PYTHON% -c "import MetaTrader5 as mt5; import requests, json, time, uuid, sys, threading, os

SERVER = '{{SERVER_URL}}'
TOKEN = '{{TOKEN}}'
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
        except: pass

    def heartbeat(self):
        now = time.time()
        if now - self.last_heartbeat < HEARTBEAT_INTERVAL: return
        self.last_heartbeat = now
        try:
            info = mt5.account_info()
            pos = mt5.positions_get()
            self.account_info = {
                'balance': info.balance if info else 0, 'equity': info.equity if info else 0,
                'margin': info.margin if info else 0, 'free_margin': info.margin_free if info else 0,
                'profit': info.profit if info else 0, 'positions': len(pos) if pos else 0,
                'server': info.server if info else '', 'login': info.login if info else 0,
            }
            requests.post(SERVER + '/aurum-api/bridge/result',
                json={'command_id': '_heartbeat', 'session_id': self.session_id,
                      'result': {'status': 'alive', 'account': self.account_info}},
                headers=self.headers(), timeout=5)
        except: pass

    def connect_mt5(self):
        if not mt5.initialize():
            return {'status': 'error', 'message': 'MT5初始化失败: ' + str(mt5.last_error())}
        info = mt5.account_info()
        if not info:
            return {'status': 'error', 'message': '无法获取账户信息'}
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
                result = {'error': 'unknown action: ' + str(action)}
        except Exception as e:
            result = {'error': str(e)}
        self.report(cmd_id, result)

    def open_trade(self, p):
        symbol = p.get('symbol', SYMBOL)
        lot = float(p.get('volume', 0.01))
        sl = float(p.get('sl', 0)) or None
        tp = float(p.get('tp', 0)) or None
        comment = p.get('comment', 'AURUM')
        info = mt5.symbol_info(symbol)
        if not info: return {'error': symbol + ' not found'}
        if not info.visible: mt5.symbol_select(symbol, True)
        point = info.point
        price = mt5.symbol_info_tick(symbol).ask
        order_type = mt5.ORDER_TYPE_BUY if p.get('direction') in ('buy','long') else mt5.ORDER_TYPE_SELL
        request = {'action': mt5.TRADE_ACTION_DEAL, 'symbol': symbol, 'volume': lot,
                   'type': order_type, 'price': price, 'deviation': 20, 'magic': 202606,
                   'comment': comment, 'type_filling': mt5.ORDER_FILLING_IOC}
        if sl: request['sl'] = price - sl * point if order_type == mt5.ORDER_TYPE_BUY else price + sl * point
        if tp: request['tp'] = price + tp * point if order_type == mt5.ORDER_TYPE_BUY else price - tp * point
        result = mt5.order_send(request)
        if result.retcode != mt5.TRADE_RETCODE_DONE:
            return {'error': str(result.retcode), 'message': result.comment}
        return {'ticket': result.order, 'price': result.price, 'volume': result.volume}

    def close_trade(self, p):
        ticket = p.get('ticket')
        pos = mt5.positions_get(ticket=ticket)
        if not pos: return {'error': 'position not found'}
        pos = pos[0]
        tick = mt5.symbol_info_tick(pos.symbol)
        price = tick.bid if pos.type == 0 else tick.ask
        request = {'action': mt5.TRADE_ACTION_DEAL, 'symbol': pos.symbol, 'volume': pos.volume,
                   'type': 1 - pos.type, 'position': ticket, 'price': price,
                   'deviation': 20, 'magic': 202606, 'comment': 'AURUM-close',
                   'type_filling': mt5.ORDER_FILLING_IOC}
        result = mt5.order_send(request)
        if result.retcode != mt5.TRADE_RETCODE_DONE:
            return {'error': str(result.retcode), 'message': result.comment}
        return {'ticket': result.order, 'profit': pos.profit}

    def get_rates(self, p):
        tf_map = {'M1':1,'M5':5,'M15':15,'H1':16385,'H4':16388,'D1':16408}
        tf = tf_map.get(p.get('timeframe','H1'), 16385)
        count = min(int(p.get('count', 500)), 5000)
        rates = mt5.copy_rates_from_pos(p.get('symbol', SYMBOL), tf, 0, count)
        if rates is None: return []
        return [{'time': int(r[0]), 'open':r[1], 'high':r[2], 'low':r[3], 'close':r[4], 'volume':r[5]} for r in rates]

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
        print('[..] 连接 MT5...')
        result = self.connect_mt5()
        print('[√] MT5:', result)
        print('[..] 开始轮询服务器...')
        self.poll_loop()

bridge = Bridge()
try:
    bridge.run()
except KeyboardInterrupt:
    bridge.disconnect_mt5()
    print('桥接已停止')
"

echo.
echo 桥接服务已停止
pause
