' AURUM AI Bridge - Windows Launcher
' Double-click to run

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

' Find Python
Dim python
python = ""
Dim paths
paths = Array("python", "python3", _
    shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\Python\Python313\python.exe", _
    shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\Python\Python312\python.exe", _
    shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\Python\Python311\python.exe", _
    shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\Python\Python310\python.exe")

Dim i
For i = 0 To UBound(paths)
    If InStr(paths(i), "\") > 0 Then
        If fso.FileExists(paths(i)) Then
            python = paths(i)
            Exit For
        End If
    Else
        On Error Resume Next
        shell.Run "where " & paths(i), 0, True
        If Err.Number = 0 Then
            python = paths(i)
            On Error GoTo 0
            Exit For
        End If
        On Error GoTo 0
    End If
Next

If python = "" Then
    MsgBox "Python not found. Please install Python 3.10+" & vbCrLf & "https://www.python.org/downloads/", vbCritical, "AURUM AI Bridge"
    WScript.Quit 1
End If

' Write Python script to temp
Dim tempDir, pyFile
tempDir = shell.ExpandEnvironmentStrings("%TEMP%")
pyFile = tempDir & "\aurum_bridge_win.py"

Dim f
Set f = fso.CreateTextFile(pyFile, True, True)
f.WriteLine "import MetaTrader5 as mt5"
f.WriteLine "import requests, time, uuid, sys"
f.WriteLine ""
f.WriteLine "SERVER = '{{SERVER_URL}}'"
f.WriteLine "TOKEN = '{{TOKEN}}'"
f.WriteLine "POLL_INTERVAL = 2"
f.WriteLine "HEARTBEAT_INTERVAL = 30"
f.WriteLine "SYMBOL = 'XAUUSD.s'"
f.WriteLine ""
f.WriteLine "class Bridge:"
f.WriteLine "    def __init__(self):"
f.WriteLine "        self.session_id = 'bridge-' + str(uuid.uuid4())[:8]"
f.WriteLine "        self.connected = False"
f.WriteLine "        self.running = True"
f.WriteLine "        self.account_info = {}"
f.WriteLine "        self.last_heartbeat = 0"
f.WriteLine ""
f.WriteLine "    def headers(self):"
f.WriteLine "        return {'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json'}"
f.WriteLine ""
f.WriteLine "    def report(self, cmd_id, result):"
f.WriteLine "        try:"
f.WriteLine "            requests.post(SERVER + '/aurum-api/bridge/result',"
f.WriteLine "                json={'command_id': cmd_id, 'result': result}, headers=self.headers(), timeout=10)"
f.WriteLine "        except Exception as e:"
f.WriteLine "            print(f'[!] Report failed: {e}')"
f.WriteLine ""
f.WriteLine "    def heartbeat(self):"
f.WriteLine "        now = time.time()"
f.WriteLine "        if now - self.last_heartbeat < HEARTBEAT_INTERVAL:"
f.WriteLine "            return"
f.WriteLine "        self.last_heartbeat = now"
f.WriteLine "        try:"
f.WriteLine "            info = mt5.account_info()"
f.WriteLine "            pos = mt5.positions_get()"
f.WriteLine "            self.account_info = {"
f.WriteLine "                'balance': info.balance if info else 0,"
f.WriteLine "                'equity': info.equity if info else 0,"
f.WriteLine "                'margin': info.margin if info else 0,"
f.WriteLine "                'free_margin': info.margin_free if info else 0,"
f.WriteLine "                'profit': info.profit if info else 0,"
f.WriteLine "                'positions': len(pos) if pos else 0,"
f.WriteLine "                'server': info.server if info else '',"
f.WriteLine "                'login': info.login if info else 0,"
f.WriteLine "            }"
f.WriteLine "            requests.post(SERVER + '/aurum-api/bridge/result',"
f.WriteLine "                json={'command_id': '_heartbeat', 'session_id': self.session_id,"
f.WriteLine "                      'result': {'status': 'alive', 'account': self.account_info}},"
f.WriteLine "                headers=self.headers(), timeout=5)"
f.WriteLine "        except:"
f.WriteLine "            pass"
f.WriteLine ""
f.WriteLine "    def connect_mt5(self):"
f.WriteLine "        if not mt5.initialize():"
f.WriteLine "            return {'status': 'error', 'message': f'MT5 init failed: {mt5.last_error()}'}"
f.WriteLine "        info = mt5.account_info()"
f.WriteLine "        if not info:"
f.WriteLine "            return {'status': 'error', 'message': 'Cannot get account info'}"
f.WriteLine "        self.connected = True"
f.WriteLine "        return {'status': 'connected', 'login': info.login, 'server': info.server,"
f.WriteLine "                'balance': info.balance, 'equity': info.equity, 'leverage': info.leverage}"
f.WriteLine ""
f.WriteLine "    def disconnect_mt5(self):"
f.WriteLine "        mt5.shutdown()"
f.WriteLine "        self.connected = False"
f.WriteLine "        return {'status': 'disconnected'}"
f.WriteLine ""
f.WriteLine "    def handle_command(self, cmd):"
f.WriteLine "        action = cmd.get('action')"
f.WriteLine "        cmd_id = cmd.get('command_id')"
f.WriteLine "        params = cmd.get('params', {})"
f.WriteLine "        try:"
f.WriteLine "            if action == 'connect':"
f.WriteLine "                result = self.connect_mt5()"
f.WriteLine "            elif action == 'disconnect':"
f.WriteLine "                result = self.disconnect_mt5()"
f.WriteLine "            elif action == 'status':"
f.WriteLine "                info = mt5.account_info()"
f.WriteLine "                result = {'connected': self.connected, 'account': self.account_info,"
f.WriteLine "                          'terminal': mt5.terminal_info()._asdict() if mt5.terminal_info() else {}}"
f.WriteLine "            elif action == 'open':"
f.WriteLine "                result = self.open_trade(params)"
f.WriteLine "            elif action == 'close':"
f.WriteLine "                result = self.close_trade(params)"
f.WriteLine "            elif action == 'rates':"
f.WriteLine "                result = self.get_rates(params)"
f.WriteLine "            elif action == 'quote':"
f.WriteLine "                tick = mt5.symbol_info_tick(params.get('symbol', SYMBOL))"
f.WriteLine "                result = tick._asdict() if tick else {'error': 'no tick'}"
f.WriteLine "            elif action == 'positions':"
f.WriteLine "                pos = mt5.positions_get()"
f.WriteLine "                result = [p._asdict() for p in pos] if pos else []"
f.WriteLine "            elif action == 'account':"
f.WriteLine "                info = mt5.account_info()"
f.WriteLine "                result = info._asdict() if info else {}"
f.WriteLine "            else:"
f.WriteLine "                result = {'error': f'unknown: {action}'}"
f.WriteLine "        except Exception as e:"
f.WriteLine "            result = {'error': str(e)}"
f.WriteLine "        print(f'[CMD] {action} -> {str(result)[:100]}')"
f.WriteLine "        self.report(cmd_id, result)"
f.WriteLine ""
f.WriteLine "    def open_trade(self, p):"
f.WriteLine "        symbol = p.get('symbol', SYMBOL)"
f.WriteLine "        lot = float(p.get('volume', 0.01))"
f.WriteLine "        sl = float(p.get('sl', 0)) or None"
f.WriteLine "        tp = float(p.get('tp', 0)) or None"
f.WriteLine "        comment = p.get('comment', 'AURUM')"
f.WriteLine "        info = mt5.symbol_info(symbol)"
f.WriteLine "        if not info:"
f.WriteLine "            return {'error': f'{symbol} not found'}"
f.WriteLine "        if not info.visible:"
f.WriteLine "            mt5.symbol_select(symbol, True)"
f.WriteLine "        point = info.point"
f.WriteLine "        price = mt5.symbol_info_tick(symbol).ask"
f.WriteLine "        order_type = mt5.ORDER_TYPE_BUY if p.get('direction') in ('buy', 'long') else mt5.ORDER_TYPE_SELL"
f.WriteLine "        req = {'action': mt5.TRADE_ACTION_DEAL, 'symbol': symbol, 'volume': lot,"
f.WriteLine "               'type': order_type, 'price': price, 'deviation': 20, 'magic': 202606,"
f.WriteLine "               'comment': comment, 'type_filling': mt5.ORDER_FILLING_IOC}"
f.WriteLine "        if sl:"
f.WriteLine "            req['sl'] = price - sl * point if order_type == mt5.ORDER_TYPE_BUY else price + sl * point"
f.WriteLine "        if tp:"
f.WriteLine "            req['tp'] = price + tp * point if order_type == mt5.ORDER_TYPE_BUY else price - tp * point"
f.WriteLine "        result = mt5.order_send(req)"
f.WriteLine "        if result.retcode != mt5.TRADE_RETCODE_DONE:"
f.WriteLine "            return {'error': str(result.retcode), 'message': result.comment}"
f.WriteLine "        return {'ticket': result.order, 'price': result.price, 'volume': result.volume}"
f.WriteLine ""
f.WriteLine "    def close_trade(self, p):"
f.WriteLine "        ticket = p.get('ticket')"
f.WriteLine "        pos = mt5.positions_get(ticket=ticket)"
f.WriteLine "        if not pos:"
f.WriteLine "            return {'error': 'position not found'}"
f.WriteLine "        pos = pos[0]"
f.WriteLine "        tick = mt5.symbol_info_tick(pos.symbol)"
f.WriteLine "        price = tick.bid if pos.type == 0 else tick.ask"
f.WriteLine "        req = {'action': mt5.TRADE_ACTION_DEAL, 'symbol': pos.symbol, 'volume': pos.volume,"
f.WriteLine "               'type': 1 - pos.type, 'position': ticket, 'price': price,"
f.WriteLine "               'deviation': 20, 'magic': 202606, 'comment': 'AURUM-close',"
f.WriteLine "               'type_filling': mt5.ORDER_FILLING_IOC}"
f.WriteLine "        result = mt5.order_send(req)"
f.WriteLine "        if result.retcode != mt5.TRADE_RETCODE_DONE:"
f.WriteLine "            return {'error': str(result.retcode), 'message': result.comment}"
f.WriteLine "        return {'ticket': result.order, 'profit': pos.profit}"
f.WriteLine ""
f.WriteLine "    def get_rates(self, p):"
f.WriteLine "        tf_map = {'M1': 1, 'M5': 5, 'M15': 15, 'H1': 16385, 'H4': 16388, 'D1': 16408}"
f.WriteLine "        tf = tf_map.get(p.get('timeframe', 'H1'), 16385)"
f.WriteLine "        count = min(int(p.get('count', 500)), 5000)"
f.WriteLine "        rates = mt5.copy_rates_from_pos(p.get('symbol', SYMBOL), tf, 0, count)"
f.WriteLine "        if rates is None:"
f.WriteLine "            return []"
f.WriteLine "        return [{'time': int(r[0]), 'open': r[1], 'high': r[2], 'low': r[3], 'close': r[4], 'volume': r[5]} for r in rates]"
f.WriteLine ""
f.WriteLine "    def poll_loop(self):"
f.WriteLine "        while self.running:"
f.WriteLine "            try:"
f.WriteLine "                r = requests.get(SERVER + '/aurum-api/bridge/poll', headers=self.headers(), timeout=15)"
f.WriteLine "                if r.status_code == 200:"
f.WriteLine "                    cmds = r.json().get('commands', [])"
f.WriteLine "                    for cmd in cmds:"
f.WriteLine "                        self.handle_command(cmd)"
f.WriteLine "                    self.heartbeat()"
f.WriteLine "                else:"
f.WriteLine "                    print(f'[!] Server returned {r.status_code}')"
f.WriteLine "                    time.sleep(5)"
f.WriteLine "            except requests.exceptions.Timeout:"
f.WriteLine "                self.heartbeat()"
f.WriteLine "            except Exception as e:"
f.WriteLine "                print(f'[!] Error: {e}')"
f.WriteLine "                time.sleep(5)"
f.WriteLine ""
f.WriteLine "    def run(self):"
f.WriteLine "        print(f'[OK] Bridge session: {self.session_id}')"
f.WriteLine "        print('[..] Connecting MT5...')"
f.WriteLine "        result = self.connect_mt5()"
f.WriteLine "        print(f'[OK] MT5: {result}')"
f.WriteLine "        print('[..] Polling server...\n')"
f.WriteLine "        self.poll_loop()"
f.WriteLine ""
f.WriteLine "if __name__ == '__main__':"
f.WriteLine "    bridge = Bridge()"
f.WriteLine "    try:"
f.WriteLine "        bridge.run()"
f.WriteLine "    except KeyboardInterrupt:"
f.WriteLine "        bridge.disconnect_mt5()"
f.WriteLine "        print('\nBridge stopped.')"
f.WriteLine "    except Exception as e:"
f.WriteLine "        print(f'[FATAL] {e}')"
f.WriteLine "        import traceback; traceback.print_exc()"
f.WriteLine "        input('\nPress Enter to exit...')"
f.Close

' Install dependencies
shell.Run "cmd /c " & python & " -m pip install --quiet MetaTrader5 requests", 0, True

' Run bridge in visible cmd window
shell.Run "cmd /k " & python & " " & pyFile, 1, False

WScript.Echo "Bridge started. You can close this window."
