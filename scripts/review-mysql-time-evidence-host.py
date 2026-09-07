"""Read only MySQL logging metadata; never emit credentials or SQL event bodies."""
import json
import os
import subprocess
import sys

if sys.platform != 'linux' or os.getuid() != 0:
    raise SystemExit('unsupported_host')
reader = "import os,sys,json;os.chdir('/www/server/panel');sys.path.insert(0,'/www/server/panel/class');import public;print(json.dumps(public.M('config').where('id=?',(1,)).getField('mysql_root')))"
result = subprocess.run(['/www/server/panel/pyenv/bin/python3','-B','-c',reader], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=True, timeout=20)
password = json.loads(result.stdout)
if not isinstance(password,str) or not password or '\x00' in password:
    raise SystemExit('credential_invalid')
code = r"""
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
const mysql=createRequire(import.meta.url)('/www/wwwroot/aurum-ai/node_modules/mysql2/promise.js')
let c
try {
 const credentials=JSON.parse(await readFile(`/proc/self/fd/${process.env.CREDENTIAL_FD}`,'utf8'))
 c=await mysql.createConnection({...credentials,database:'dev_vue'})
 const [[identity]]=await c.query('SELECT DATABASE() db,@@server_uuid uuid,VERSION() version')
 if(identity.db!=='dev_vue'||identity.uuid!=='ac423207-6ef3-11f1-b302-000c29fda104')throw Error('identity_invalid')
 const [variables]=await c.query("SHOW GLOBAL VARIABLES WHERE Variable_name IN ('time_zone','system_time_zone','log_bin','binlog_format','binlog_expire_logs_seconds','general_log','log_output')")
 const [uptime]=await c.query("SHOW GLOBAL STATUS LIKE 'Uptime'")
 let binaryLogs=[],binaryLogsCode=null
 try {const [rows]=await c.query('SHOW BINARY LOGS');binaryLogs=rows.map(r=>({name:r.Log_name,size:String(r.File_size),encrypted:r.Encrypted}))}catch(e){if(e.errno!==1381)throw e;binaryLogsCode='disabled'}
 const [[journal]]=await c.query("SELECT COUNT(*) n FROM database_upgrade_steps_v4 WHERE status='completed'")
 console.log(JSON.stringify({kind:'mysql-time-evidence-availability/v1',identity,observedAtUtc:new Date().toISOString(),variables,uptime,
 binaryLogs,binaryLogsCode,completedUpgradeSteps:Number(journal.n),eventBodiesRead:false,historicalTimezoneProven:false,databaseWritten:false}))
}catch(e){console.error(JSON.stringify({code:e.code??'time_evidence_failed'}));process.exitCode=1}finally{await c?.end()}
"""
fd = os.memfd_create('mysql-time-evidence',os.MFD_CLOEXEC)
try:
    os.fchmod(fd,0o600)
    os.write(fd,json.dumps({'user':'root','password':password,'socketPath':'/tmp/mysql.sock'}).encode())
    os.lseek(fd,0,os.SEEK_SET)
    run=subprocess.run(['/www/server/nodejs/v24.18.0/bin/node','--input-type=module','-e',code],env={'PATH':'/usr/bin:/bin','CREDENTIAL_FD':str(fd)},pass_fds=(fd,),timeout=40)
    sys.exit(run.returncode)
finally:
    os.close(fd)
