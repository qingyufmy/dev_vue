' AURUM AI Bridge - Windows
' Double-click to run

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
Set stream = CreateObject("ADODB.Stream")

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
    MsgBox "Python not found." & vbCrLf & "Install: https://www.python.org/downloads/", vbCritical, "AURUM AI Bridge"
    WScript.Quit 1
End If

' Write Python script (UTF-8 no BOM via ADODB.Stream)
Dim pyFile
pyFile = shell.ExpandEnvironmentStrings("%TEMP%") & "\aurum_bridge.py"

Dim code
code = "" & _
"import MetaTrader5 as mt5" & vbCrLf & _
"import requests, time, uuid, sys" & vbCrLf & _
"" & vbCrLf & _
"SERVER = '{{SERVER_URL}}'" & vbCrLf & _
"TOKEN = '{{TOKEN}}'" & vbCrLf & _
"SYMBOL = 'XAUUSD.s'" & vbCrLf & _
"" & vbCrLf & _
"class Bridge:" & vbCrLf & _
"    def __init__(self):" & vbCrLf & _
"        self.sid = 'br-' + str(uuid.uuid4())[:8]" & vbCrLf & _
"        self.ok = False" & vbCrLf & _
"        self.running = True" & vbCrLf & _
"        self.info = {}" & vbCrLf & _
"        self.hb = 0" & vbCrLf & _
"    def hdr(self):" & vbCrLf & _
"        return {'Authorization': 'Bearer '+TOKEN, 'Content-Type': 'application/json'}" & vbCrLf & _
"    def report(self, cid, res):" & vbCrLf & _
"        try: requests.post(SERVER+'/aurum-api/bridge/result', json={'command_id':cid,'result':res}, headers=self.hdr(), timeout=10)" & vbCrLf & _
"        except: pass" & vbCrLf & _
"    def heartbeat(self):" & vbCrLf & _
"        now=time.time()" & vbCrLf & _
"        if now-self.hb<30: return" & vbCrLf & _
"        self.hb=now" & vbCrLf & _
"        try:" & vbCrLf & _
"            a=mt5.account_info(); p=mt5.positions_get()" & vbCrLf & _
"            self.info={'balance':a.balance if a else 0,'equity':a.equity if a else 0,'margin':a.margin if a else 0,'free':a.margin_free if a else 0,'profit':a.profit if a else 0,'pos':len(p) if p else 0,'server':a.server if a else '','login':a.login if a else 0}" & vbCrLf & _
"            requests.post(SERVER+'/aurum-api/bridge/result', json={'command_id':'_hb','session_id':self.sid,'result':{'status':'alive','account':self.info}}, headers=self.hdr(), timeout=5)" & vbCrLf & _
"        except: pass" & vbCrLf & _
"    def connect(self):" & vbCrLf & _
"        if not mt5.initialize(): return {'status':'error','message':str(mt5.last_error())}" & vbCrLf & _
"        a=mt5.account_info()" & vbCrLf & _
"        if not a: return {'status':'error','message':'no account'}" & vbCrLf & _
"        self.ok=True" & vbCrLf & _
"        return {'status':'connected','login':a.login,'server':a.server,'balance':a.balance,'equity':a.equity}" & vbCrLf & _
"    def disconnect(self):" & vbCrLf & _
"        mt5.shutdown(); self.ok=False; return {'status':'disconnected'}" & vbCrLf & _
"    def handle(self, cmd):" & vbCrLf & _
"        act=cmd.get('action'); cid=cmd.get('command_id'); par=cmd.get('params',{})" & vbCrLf & _
"        try:" & vbCrLf & _
"            if act=='connect': r=self.connect()" & vbCrLf & _
"            elif act=='disconnect': r=self.disconnect()" & vbCrLf & _
"            elif act=='status': a=mt5.account_info(); r={'connected':self.ok,'account':self.info}" & vbCrLf & _
"            elif act=='open': r=self.open_trade(par)" & vbCrLf & _
"            elif act=='close': r=self.close_trade(par)" & vbCrLf & _
"            elif act=='rates': r=self.get_rates(par)" & vbCrLf & _
"            elif act=='quote': t=mt5.symbol_info_tick(par.get('symbol',SYMBOL)); r=t._asdict() if t else {'error':'no tick'}" & vbCrLf & _
"            elif act=='positions': ps=mt5.positions_get(); r=[p._asdict() for p in ps] if ps else []" & vbCrLf & _
"            elif act=='account': a=mt5.account_info(); r=a._asdict() if a else {}" & vbCrLf & _
"            else: r={'error':'unknown: '+str(act)}" & vbCrLf & _
"        except Exception as e: r={'error':str(e)}" & vbCrLf & _
"        print(f'[CMD] {act} -> {str(r)[:80]}')" & vbCrLf & _
"        self.report(cid, r)" & vbCrLf & _
"    def open_trade(self, p):" & vbCrLf & _
"        sym=p.get('symbol',SYMBOL); lot=float(p.get('volume',0.01))" & vbCrLf & _
"        sl=float(p.get('sl',0)) or None; tp=float(p.get('tp',0)) or None" & vbCrLf & _
"        info=mt5.symbol_info(sym)" & vbCrLf & _
"        if not info: return {'error':sym+' not found'}" & vbCrLf & _
"        if not info.visible: mt5.symbol_select(sym,True)" & vbCrLf & _
"        pt=info.point; px=mt5.symbol_info_tick(sym).ask" & vbCrLf & _
"        ot=mt5.ORDER_TYPE_BUY if p.get('direction') in ('buy','long') else mt5.ORDER_TYPE_SELL" & vbCrLf & _
"        req={'action':mt5.TRADE_ACTION_DEAL,'symbol':sym,'volume':lot,'type':ot,'price':px,'deviation':20,'magic':202606,'comment':p.get('comment','AURUM'),'type_filling':mt5.ORDER_FILLING_IOC}" & vbCrLf & _
"        if sl: req['sl']=px-sl*pt if ot==mt5.ORDER_TYPE_BUY else px+sl*pt" & vbCrLf & _
"        if tp: req['tp']=px+tp*pt if ot==mt5.ORDER_TYPE_BUY else px-tp*pt" & vbCrLf & _
"        r=mt5.order_send(req)" & vbCrLf & _
"        if r.retcode!=mt5.TRADE_RETCODE_DONE: return {'error':str(r.retcode),'message':r.comment}" & vbCrLf & _
"        return {'ticket':r.order,'price':r.price,'volume':r.volume}" & vbCrLf & _
"    def close_trade(self, p):" & vbCrLf & _
"        t=p.get('ticket'); ps=mt5.positions_get(ticket=t)" & vbCrLf & _
"        if not ps: return {'error':'not found'}" & vbCrLf & _
"        pos=ps[0]; tk=mt5.symbol_info_tick(pos.symbol); px=tk.bid if pos.type==0 else tk.ask" & vbCrLf & _
"        req={'action':mt5.TRADE_ACTION_DEAL,'symbol':pos.symbol,'volume':pos.volume,'type':1-pos.type,'position':t,'price':px,'deviation':20,'magic':202606,'comment':'AURUM-close','type_filling':mt5.ORDER_FILLING_IOC}" & vbCrLf & _
"        r=mt5.order_send(req)" & vbCrLf & _
"        if r.retcode!=mt5.TRADE_RETCODE_DONE: return {'error':str(r.retcode),'message':r.comment}" & vbCrLf & _
"        return {'ticket':r.order,'profit':pos.profit}" & vbCrLf & _
"    def get_rates(self, p):" & vbCrLf & _
"        tf={'M1':1,'M5':5,'M15':15,'H1':16385,'H4':16388,'D1':16408}" & vbCrLf & _
"        t=tf.get(p.get('timeframe','H1'),16385); c=min(int(p.get('count',500)),5000)" & vbCrLf & _
"        rs=mt5.copy_rates_from_pos(p.get('symbol',SYMBOL),t,0,c)" & vbCrLf & _
"        if rs is None: return []" & vbCrLf & _
"        return [{'time':int(r[0]),'open':r[1],'high':r[2],'low':r[3],'close':r[4],'volume':r[5]} for r in rs]" & vbCrLf & _
"    def loop(self):" & vbCrLf & _
"        while self.running:" & vbCrLf & _
"            try:" & vbCrLf & _
"                r=requests.get(SERVER+'/aurum-api/bridge/poll',headers=self.hdr(),timeout=15)" & vbCrLf & _
"                if r.status_code==200:" & vbCrLf & _
"                    for c in r.json().get('commands',[]): self.handle(c)" & vbCrLf & _
"                    self.heartbeat()" & vbCrLf & _
"                else: time.sleep(5)" & vbCrLf & _
"            except requests.exceptions.Timeout: self.heartbeat()" & vbCrLf & _
"            except Exception as e: print(f'[!] {e}'); time.sleep(5)" & vbCrLf & _
"    def run(self):" & vbCrLf & _
"        print(f'[OK] Session: {self.sid}')" & vbCrLf & _
"        print('[..] Connecting MT5...')" & vbCrLf & _
"        print(f'[OK] {self.connect()}')" & vbCrLf & _
"        print('[..] Polling server...\n')" & vbCrLf & _
"        self.loop()" & vbCrLf & _
"" & vbCrLf & _
"if __name__=='__main__':" & vbCrLf & _
"    b=Bridge()" & vbCrLf & _
"    try: b.run()" & vbCrLf & _
"    except KeyboardInterrupt: b.disconnect(); print('\nStopped.')" & vbCrLf & _
"    except Exception as e: print(f'[FATAL] {e}'); import traceback; traceback.print_exc(); input()"

stream.Type = 2
stream.Charset = "utf-8"
stream.Open
stream.WriteText code
stream.SaveToFile pyFile, 2
stream.Close

' Install deps silently
shell.Run "cmd /c " & python & " -m pip install --quiet MetaTrader5 requests 2>nul", 0, True

' Run in visible window
shell.Run "cmd /k " & python & " " & pyFile, 1, False

WScript.Echo "Bridge started. Close this window anytime."
