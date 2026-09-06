import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
const check = (ok, code) => { if (!ok) throw Error(code) }, sha = value => createHash('sha256').update(value).digest('hex')
const normalize = ddl => ddl.replace(/ AUTO_INCREMENT=\d+/g, '')
let c
try {
  check(process.platform === 'linux' && process.getuid() === 0, 'settings_tokens_scope')
  const mysql = createRequire(import.meta.url)('/www/wwwroot/aurum-ai/node_modules/mysql2/promise.js')
  c = await mysql.createConnection({ ...JSON.parse(await readFile(`/proc/self/fd/${process.env.V4_BACKUP_CREDENTIAL_FD}`)), database:'dev_vue_m1_a' })
  const [[identity]] = await c.query('SELECT DATABASE() db,@@server_uuid uuid,VERSION() version')
  check(identity.db==='dev_vue_m1_a' && identity.uuid==='ac423207-6ef3-11f1-b302-000c29fda104','settings_tokens_identity')
  const [[before]] = await c.query('SHOW CREATE TABLE system_settings')
  const prior = JSON.parse(await readFile(new URL('prior.json',import.meta.url)))
  check(normalize(before['Create Table'])===normalize(prior.definitions[0].ddl),'settings_tokens_before')
  const [[counts]] = await c.query('SELECT COUNT(*) n FROM system_settings');check(Number(counts.n)===0,'settings_tokens_not_empty')
  const [[boundary]] = await c.execute("SELECT REGEXP_LIKE(?, '^(true|false)$', 'c') accepted",['true\n'])
  check(Number(boundary.accepted)===1,'settings_tokens_boundary')
  const sql = await readFile(new URL('020_system_settings_exact_tokens.sql',import.meta.url),'utf8');await c.query(sql)
  const [[after]] = await c.query('SHOW CREATE TABLE system_settings')
  await c.beginTransaction()
  const base={id:777990,namespace:'fixture',setting_key:'flag',value_type:'boolean',value_text:'true',sensitivity:'restricted',created_at_utc:'2026-09-07 00:00:00.123',updated_at_utc:'2026-09-07 00:00:00.456',origin:'native'}
  const fields=Object.keys(base),insert=row=>c.execute(`INSERT INTO system_settings (${fields.join(',')}) VALUES (${fields.map(()=>'?').join(',')})`,fields.map(k=>row[k]))
  await insert(base)
  const rejected=[]
  for(const [name,patch] of [['namespace_lf',{namespace:'fixture\n'}],['key_lf',{setting_key:'flag\n'}],['type_lf',{value_type:'boolean\n'}],['sensitivity_lf',{sensitivity:'restricted\n'}],['boolean_lf',{value_text:'true\n'}],['integer_lf',{value_type:'integer',value_text:'1\n'}],['boolean_cr',{value_text:'false\r'}]]){
    let code;try{await insert({...base,id:777991,setting_key:'invalid',...patch})}catch(e){code=e.code}
    check(code==='ER_CHECK_CONSTRAINT_VIOLATED','settings_tokens_negative');rejected.push(name)
  }
  await c.rollback()
  const [[final]] = await c.query('SELECT COUNT(*) n FROM system_settings');check(Number(final.n)===0,'settings_tokens_cleanup')
  await writeFile(new URL('receipt.json',import.meta.url),JSON.stringify({kind:'settings-exact-tokens-probe/v1',identity,sourceSqlSha256:sha(sql),beforeDdl:before['Create Table'],afterDdl:after['Create Table'],regexBoundaryObserved:true,rejected,rolledBack:true,remainingRows:0,currentDevVueWritten:false},null,2)+'\n',{flag:'wx',mode:0o600})
  console.log(JSON.stringify({status:'verified',rejected:rejected.length,rolledBack:true}))
}catch(e){await c?.rollback().catch(()=>{});console.error(JSON.stringify({code:e.code??e.message}));process.exitCode=1}finally{await c?.end()}
