import { spawnSync } from 'node:child_process'

// Only the pre-existing recovery database. The remote process handles the panel
// password in memory; neither credentials nor GRANT text leave the SSH process.
export function learningCompletionGrantSource(host, action, expectedHash = '') {
  if (!/^[a-zA-Z0-9_.-]+$/.test(host) || !['grant', 'restore'].includes(action)
    || (action === 'restore' && !/^[0-9a-f]{64}$/.test(expectedHash))) throw Error('learning_completion_grant_arguments')
  const source = `import os,sys,json,subprocess,hashlib
reader="import os,sys,json;os.chdir('/www/server/panel');sys.path.insert(0,'/www/server/panel/class');import public;print(json.dumps(public.M('config').where('id=?',(1,)).getField('mysql_root')))"
loaded=subprocess.run(['/www/server/panel/pyenv/bin/python3','-B','-c',reader],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=20,check=True)
password=json.loads(loaded.stdout)
if not isinstance(password,str) or not password or '\\x00' in password: raise ValueError('credential')
def quote(s): return '"'+s.replace('\\\\','\\\\\\\\').replace('"','\\\\"').replace('\\n','\\\\n').replace('\\r','\\\\r')+'"'
fd=os.memfd_create('learning-completion-probe',os.MFD_CLOEXEC)
os.fchmod(fd,0o600)
os.write(fd,('[client]\\nuser=root\\npassword='+quote(password)+'\\nprotocol=SOCKET\\nsocket=/tmp/mysql.sock\\n').encode())
def sql(query):
  p=subprocess.run(['/www/server/mysql/bin/mysql','--defaults-extra-file=/proc/self/fd/'+str(fd),'--batch','--skip-column-names','--raw'],input=query.encode(),stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,pass_fds=(fd,),timeout=30)
  if p.returncode: raise ValueError('mysql_failed')
  return p.stdout.decode().strip()
try:
  if sql('SELECT @@server_uuid')!='ac423207-6ef3-11f1-b302-000c29fda104': raise ValueError('identity')
  before=sql("SHOW GRANTS FOR 'dev_vue'@'%'")
  digest=lambda value: hashlib.sha256(value.encode()).hexdigest()
  scope='dev_vue_m1_source_20260907_02'
  escaped=scope.replace('_',chr(92)+'_')
  privileges='SELECT,INSERT,UPDATE,DELETE,CREATE,DROP,REFERENCES,ALTER'
  if ${JSON.stringify(action)}=='grant':
    if scope in before.replace(chr(92),''): raise ValueError('existing_scope')
    sql('GRANT '+privileges+' ON \`'+escaped+"\`.* TO 'dev_vue'@'%'")
    print(json.dumps({'status':'granted','priorGrantsSha256':digest(before)}))
  else:
    sql('REVOKE '+privileges+' ON \`'+escaped+"\`.* FROM 'dev_vue'@'%'")
    after=sql("SHOW GRANTS FOR 'dev_vue'@'%'")
    if digest(after)!=${JSON.stringify(expectedHash)}: raise ValueError('grant_restore_mismatch')
    print(json.dumps({'status':'restored','grantsSha256':digest(after)}))
finally: os.close(fd)
`
  return source
}

export function learningCompletionProbeGrant(host, action, expectedHash = '') {
  const source = learningCompletionGrantSource(host, action, expectedHash)
  const result = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host,
    '/usr/bin/python3 -B -'], { input: source, encoding: 'utf8', timeout: 60000, windowsHide: true })
  if (result.status !== 0) {
    const category = result.stderr?.match(/SyntaxError|IndentationError|ValueError|ModuleNotFoundError|Permission denied|Connection refused/)?.[0]?.replaceAll(' ', '_').toLowerCase() ?? 'failed'
    throw Error(`learning_completion_grant_${action}_${category}`)
  }
  const report = JSON.parse(result.stdout.trim())
  if (!['granted', 'restored'].includes(report.status)) throw Error('learning_completion_grant_response')
  return report
}
