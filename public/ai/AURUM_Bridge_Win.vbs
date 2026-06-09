Option Explicit
Const TEMP_DIR = 2

' ===== Config =====
Dim serverUrl, token
serverUrl = "{{SERVER_URL}}"
token = "{{TOKEN}}"

' ===== Find venv Python =====
Dim pythonPath, fso
Set fso = CreateObject("Scripting.FileSystemObject")

pythonPath = ""

' Priority 1: venv Python (known to have MetaTrader5)
Dim venvPy
venvPy = fso.GetSpecialFolder(TEMP_DIR) & "\aurum_venv_path.txt"

' Check common venv locations
Dim venvPaths(3)
venvPaths(0) = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName)) & "\.venv\Scripts\python.exe"
venvPaths(1) = fso.GetSpecialFolder(0) & "\..\Desktop\黄金AI分析\.venv\Scripts\python.exe"
venvPaths(2) = "C:\Users\Administrator\Desktop\黄金AI分析\.venv\Scripts\python.exe"
venvPaths(3) = "C:\Users\Administrator\Desktop\web\.venv\Scripts\python.exe"

Dim i
For i = 0 To 3
    If fso.FileExists(venvPaths(i)) Then
        pythonPath = venvPaths(i)
        Exit For
    End If
Next

' Priority 2: global python (if venv not found)
If pythonPath = "" Then
    Dim objShell2
    Set objShell2 = CreateObject("WScript.Shell")
    Dim execObj
    Set execObj = objShell2.Exec("cmd /c where python 2>nul")
    Dim whereOutput
    whereOutput = ""
    Do While Not execObj.StdOut.AtEndOfStream
        whereOutput = whereOutput & execObj.StdOut.ReadLine()
    Loop
    If whereOutput <> "" And fso.FileExists(Trim(Split(whereOutput, vbCrLf)(0))) Then
        pythonPath = Trim(Split(whereOutput, vbCrLf)(0))
    End If
    Set objShell2 = Nothing
End If

If pythonPath = "" Then
    MsgBox "未找到 Python！" & vbCrLf & vbCrLf & _
           "请确认以下任一位置存在 Python：" & vbCrLf & _
           "  C:\Users\Administrator\AppData\Local\Programs\Python\Python313\python.exe" & vbCrLf & _
           "  C:\Python313\python.exe" & vbCrLf & vbCrLf & _
           "或者安装 Python 后重试。", vbCritical, "AURUM Bridge"
    WScript.Quit 1
End If

' ===== Write Python script to %TEMP% =====
Dim tempFolder, pyFile
tempFolder = fso.GetSpecialFolder(TEMP_DIR)
pyFile = tempFolder & "\aurum_bridge.py"

Dim fso2, outFile
Set fso2 = CreateObject("Scripting.FileSystemObject")
Set outFile = fso2.CreateTextFile(pyFile, True, False)  ' ASCII (no BOM)

outFile.WriteLine "import sys, time, json, urllib.request, urllib.error"
outFile.WriteLine "try:"
outFile.WriteLine "    import MetaTrader5 as mt5"
outFile.WriteLine "except ImportError:"
outFile.WriteLine "    print('MetaTrader5 not installed, installing...')"
outFile.WriteLine "    import subprocess"
outFile.WriteLine "    subprocess.check_call([sys.executable, '-m', 'pip', 'install', 'MetaTrader5', '-q'])"
outFile.WriteLine "    import MetaTrader5 as mt5"
outFile.WriteLine ""
outFile.WriteLine "SERVER_URL = '" & serverUrl & "'"
outFile.WriteLine "TOKEN = '" & token & "'"
outFile.WriteLine "POLL_INTERVAL = 2"
outFile.WriteLine "HEARTBEAT_INTERVAL = 10"
outFile.WriteLine ""
outFile.WriteLine "def api(method, path, body=None):"
outFile.WriteLine "    url = SERVER_URL + '/aurum-api' + path"
outFile.WriteLine "    data = json.dumps(body).encode() if body else None"
outFile.WriteLine "    req = urllib.request.Request(url, data=data, method=method)"
outFile.WriteLine "    req.add_header('Content-Type', 'application/json')"
outFile.WriteLine "    req.add_header('Authorization', 'Bearer ' + TOKEN)"
outFile.WriteLine "    try:"
outFile.WriteLine "        resp = urllib.request.urlopen(req, timeout=30)"
outFile.WriteLine "        return json.loads(resp.read())"
outFile.WriteLine "    except Exception as e:"
outFile.WriteLine "        return {'error': str(e)}"
outFile.WriteLine ""
outFile.WriteLine "def heartbeat():"
outFile.WriteLine "    try:"
outFile.WriteLine "        account = mt5.account_info()"
outFile.WriteLine "        terminal = mt5.terminal_info()"
outFile.WriteLine "        api('POST', '/bridge/heartbeat', {"
outFile.WriteLine "            'account': {"
outFile.WriteLine "                'login': account.login if account else None,"
outFile.WriteLine "                'balance': account.balance if account else None,"
outFile.WriteLine "                'equity': account.equity if account else None,"
outFile.WriteLine "                'server': account.server if account else None"
outFile.WriteLine "            },"
outFile.WriteLine "            'terminal': {"
outFile.WriteLine "                'build': terminal.build if terminal else None,"
outFile.WriteLine "                'connected': terminal.connected if terminal else None"
outFile.WriteLine "            }"
outFile.WriteLine "        })"
outFile.WriteLine "    except: pass"
outFile.WriteLine ""
outFile.WriteLine "def process_command(cmd):"
outFile.WriteLine "    action = cmd.get('action')"
outFile.WriteLine "    params = cmd.get('params', {})"
outFile.WriteLine "    try:"
outFile.WriteLine "        if action == 'open':"
outFile.WriteLine "            order_type = mt5.ORDER_TYPE_BUY if params.get('type','buy')=='buy' else mt5.ORDER_TYPE_SELL"
OutFile.WriteLine "            request = {"
outFile.WriteLine "                'action': mt5.TRADE_ACTION_DEAL,"
outFile.WriteLine "                'symbol': params.get('symbol','XAUUSD.s'),"
outFile.WriteLine "                'volume': float(params.get('lot',0.01)),"
outFile.WriteLine "                'type': order_type,"
outFile.WriteLine "                'magic': 234000,"
outFile.WriteLine "                'comment': params.get('comment','AURUM'),"
outFile.WriteLine "                'type_time': mt5.ORDER_TIME_GTC,"
outFile.WriteLine "                'type_filling': mt5.ORDER_FILLING_IOC"
outFile.WriteLine "            }"
outFile.WriteLine "            if params.get('sl'): request['sl'] = float(params['sl'])"
outFile.WriteLine "            if params.get('tp'): request['tp'] = float(params['tp'])"
outFile.WriteLine "            result = mt5.order_send(request)"
outFile.WriteLine "            if result and result.retcode == mt5.TRADE_RETCODE_DONE:"
outFile.WriteLine "                return {'status':'success','order':result.order,'price':result.price}"
outFile.WriteLine "            else:"
outFile.WriteLine "                return {'status':'error','message':result.comment if result else 'order_send failed'}"
outFile.WriteLine "        elif action == 'close':"
outFile.WriteLine "            positions = mt5.positions_get(symbol=params.get('symbol','XAUUSD.s'))"
outFile.WriteLine "            if not positions: return {'status':'success','message':'No positions'}"
outFile.WriteLine "            for pos in positions:"
outFile.WriteLine "                close_type = mt5.ORDER_TYPE_SELL if pos.type==mt5.ORDER_TYPE_BUY else mt5.ORDER_TYPE_BUY"
outFile.WriteLine "                close_request = {"
outFile.WriteLine "                    'action': mt5.TRADE_ACTION_DEAL,"
outFile.WriteLine "                    'symbol': pos.symbol,"
outFile.WriteLine "                    'volume': pos.volume,"
outFile.WriteLine "                    'type': close_type,"
outFile.WriteLine "                    'position': pos.ticket,"
outFile.WriteLine "                    'magic': 234000,"
outFile.WriteLine "                    'type_filling': mt5.ORDER_FILLING_IOC"
outFile.WriteLine "                }"
outFile.WriteLine "                mt5.order_send(close_request)"
outFile.WriteLine "            return {'status':'success','closed':len(positions)}"
outFile.WriteLine "        elif action == 'rates':"
outFile.WriteLine "            rates = mt5.copy_rates_from_pos(params.get('symbol','XAUUSD.s'), mt5.TIMEFRAME_M5, 0, 200)"
outFile.WriteLine "            if rates is not None and len(rates)>0:"
outFile.WriteLine "                import datetime"
outFile.WriteLine "                out = []"
outFile.WriteLine "                for r in rates:"
outFile.WriteLine "                    t = datetime.datetime.fromtimestamp(int(r[0])).strftime('%Y-%m-%d %H:%M:%S')"
outFile.WriteLine "                    out.append({'time':t,'open':float(r[1]),'high':float(r[2]),'low':float(r[3]),'close':float(r[4]),'volume':int(r[5])})"
outFile.WriteLine "                return {'rates': out}"
outFile.WriteLine "            return {'rates': []}"
outFile.WriteLine "        elif action == 'quote':"
outFile.WriteLine "            tick = mt5.symbol_info_tick(params.get('symbol','XAUUSD.s'))"
outFile.WriteLine "            if tick:"
outFile.WriteLine "                return {'bid': tick.bid, 'ask': tick.ask, 'time': tick.time}"
outFile.WriteLine "            return {'error': 'no tick data'}"
outFile.WriteLine "        elif action == 'positions':"
outFile.WriteLine "            positions = mt5.positions_get()"
outFile.WriteLine "            if positions:"
outFile.WriteLine "                return {'positions': [{'ticket':p.ticket,'symbol':p.symbol,'type':'buy' if p.type==0 else 'sell','volume':p.volume,'open_price':p.price_open,'profit':p.profit,'sl':p.sl,'tp':p.tp} for p in positions]}"
outFile.WriteLine "            return {'positions': []}"
outFile.WriteLine "        elif action == 'account':"
outFile.WriteLine "            acc = mt5.account_info()"
outFile.WriteLine "            if acc:"
outFile.WriteLine "                return {'balance':acc.balance,'equity':acc.equity,'margin':acc.margin,'free_margin':acc.margin_free,'leverage':acc.leverage,'login':acc.login,'server':acc.server}"
outFile.WriteLine "            return {'error': 'no account info'}"
outFile.WriteLine "        elif action == 'close_all':"
outFile.WriteLine "            positions = mt5.positions_get()"
outFile.WriteLine "            if not positions: return {'status':'success','closed':0}"
outFile.WriteLine "            closed = 0"
outFile.WriteLine "            for pos in positions:"
outFile.WriteLine "                close_type = mt5.ORDER_TYPE_SELL if pos.type==mt5.ORDER_TYPE_BUY else mt5.ORDER_TYPE_BUY"
outFile.WriteLine "                r = {'action':mt5.TRADE_ACTION_DEAL,'symbol':pos.symbol,'volume':pos.volume,'type':close_type,'position':pos.ticket,'magic':234000,'type_filling':mt5.ORDER_FILLING_IOC}"
outFile.WriteLine "                mt5.order_send(r)"
outFile.WriteLine "                closed += 1"
outFile.WriteLine "            return {'status':'success','closed':closed}"
outFile.WriteLine "        else:"
outFile.WriteLine "            return {'error': 'unknown action: ' + str(action)}"
outFile.WriteLine "    except Exception as e:"
outFile.WriteLine "        return {'error': str(e)}"
outFile.WriteLine ""
outFile.WriteLine "def main():"
outFile.WriteLine "    print('=== AURUM MT5 Bridge ===')"
outFile.WriteLine "    print('Server: ' + SERVER_URL)"
outFile.WriteLine "    if not mt5.initialize():"
outFile.WriteLine "        print('MT5 init failed: ' + str(mt5.last_error()))"
outFile.WriteLine "        input('Press Enter to exit...')"
outFile.WriteLine "        return"
outFile.WriteLine "    info = mt5.account_info()"
outFile.WriteLine "    if info:"
outFile.WriteLine "        print('MT5: ' + str(info.login) + ' @ ' + info.server)"
outFile.WriteLine "        print('Balance: $' + str(info.balance))"
outFile.WriteLine "    print('Connected! Polling for commands...')"
outFile.WriteLine "    last_hb = 0"
outFile.WriteLine "    while True:"
outFile.WriteLine "        try:"
outFile.WriteLine "            now = time.time()"
outFile.WriteLine "            if now - last_hb > HEARTBEAT_INTERVAL:"
outFile.WriteLine "                heartbeat()"
outFile.WriteLine "                last_hb = now"
outFile.WriteLine "            result = api('GET', '/bridge/poll')"
outFile.WriteLine "            if result and result.get('command') and result['command'].get('action'):"
outFile.WriteLine "                cmd = result['command']"
outFile.WriteLine "                print('CMD: ' + cmd['action'])"
outFile.WriteLine "                resp = process_command(cmd)"
outFile.WriteLine "                api('POST', '/bridge/result', {'command_id': cmd['command_id'], 'result': resp})"
outFile.WriteLine "            time.sleep(POLL_INTERVAL)"
outFile.WriteLine "        except KeyboardInterrupt:"
outFile.WriteLine "            print('Shutting down...')"
outFile.WriteLine "            break"
outFile.WriteLine "        except Exception as e:"
outFile.WriteLine "            print('Error: ' + str(e))"
outFile.WriteLine "            time.sleep(5)"
outFile.WriteLine "    mt5.shutdown()"
outFile.WriteLine "    print('Disconnected.')"
outFile.WriteLine ""
outFile.WriteLine "main()"

outFile.Close
Set outFile = Nothing
Set fso2 = Nothing

' ===== Run Python with the script =====
Dim objShell, cmd
Set objShell = CreateObject("WScript.Shell")
cmd = """" & pythonPath & """ """ & pyFile & """"
objShell.Run cmd, 1, False  ' Normal window, don't wait
Set objShell = Nothing
Set fso = Nothing
