import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { MysqlSettingManagement } from '../server/dist-v4/modules/settings/infrastructure/mysql-setting-management.js'
import { writePrivateJson } from './lib/v4-backup-io.mjs'
const root = new URL('../', import.meta.url)
const check = (ok, code) => { if (!ok) throw new Error(code) }
let c,pool,ownsFixture=false,lockHeld=false
try {
  check(process.platform==='linux' && process.getuid()===0,'setting_management_probe_scope')
  const manifest=JSON.parse(await readFile(new URL('../tools.json',root),'utf8'))
  for(const file of manifest) {
    check(/^[a-zA-Z0-9_./-]+$/.test(file.path) && !file.path.split('/').includes('..'),'setting_management_probe_path')
    check(createHash('sha256').update(await readFile(new URL(file.path,root))).digest('hex')===file.sha256,'setting_management_probe_file')
  }
  const mysql=createRequire(import.meta.url)('/www/wwwroot/aurum-ai/node_modules/mysql2/promise.js')
  const credentials=JSON.parse(await readFile(`/proc/self/fd/${process.env.V4_BACKUP_CREDENTIAL_FD}`,'utf8'))
  const options={...credentials,database:'dev_vue_m1_a',dateStrings:true,timezone:'Z'}
  c=await mysql.createConnection(options)
  const [[identity]]=await c.query('SELECT DATABASE() db,@@server_uuid uuid,VERSION() version')
  check(identity.db==='dev_vue_m1_a' && identity.uuid==='ac423207-6ef3-11f1-b302-000c29fda104','setting_management_probe_identity')
  await c.query("SET SESSION time_zone='+00:00'")
  const [[lock]]=await c.query("SELECT GET_LOCK('v4-setting-writer-reference-probe',0) acquired")
  check(lock.acquired===1,'setting_management_probe_lock');lockHeld=true
  const [[existing]]=await c.query("SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='system_setting_requests'")
  check(Number(existing.n)===0,'setting_management_probe_schema_exists')
  const count=async table=>{check(['system_settings','system_setting_changes','system_setting_requests'].includes(table),'setting_management_probe_table');const [[r]]=await c.query(`SELECT COUNT(*) n FROM ${table}`);return Number(r.n)}
  check(await count('system_settings')===0 && await count('system_setting_changes')===0,'setting_management_probe_not_empty')
  const [[actor]]=await c.query('SELECT COUNT(*) n FROM users WHERE id=777994')
  check(Number(actor.n)===0,'setting_management_probe_actor_exists')
  const sql=await readFile(new URL('server/db/migrations/inplace/021_system_setting_requests.sql',root),'utf8')
  await c.query(sql)
  const [[ddl]]=await c.query('SHOW CREATE TABLE system_setting_requests')
  pool=mysql.createPool({...options,connectionLimit:3})
  await c.beginTransaction()
  await c.execute("INSERT INTO users (id,password,role,created_at,updated_at) VALUES (777994,'disabled-fixture','admin',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))")
  await c.execute("INSERT INTO system_settings (id,namespace,setting_key,value_type,value_text,sensitivity,created_at_utc,updated_at_utc,revision,origin) VALUES (777981,'smtp','port','integer','465','restricted',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),'9007199254740993','native')")
  ownsFixture=true;await c.commit()
  const input={namespace:'smtp',key:'port',expectedType:'integer',value:'587',expectedRevision:'9007199254740993',requestId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa138',actorUserId:777994}
  const faultPool={getConnection:async()=>{
    const connection=await pool.getConnection()
    const commit=connection.commit.bind(connection)
    connection.commit=async()=>{await commit();connection.destroy();throw Error('injected_after_real_commit')}
    return connection
  }}
  let unknown=false
  try {await new MysqlSettingManagement(faultPool).execute(input)} catch(e){unknown=e.message==='setting_commit_unknown'}
  check(unknown,'setting_management_probe_commit_unknown')
  const repo=new MysqlSettingManagement(pool)
  const recovered=await repo.execute(input)
  check(recovered.replayed && recovered.revision==='9007199254740994','setting_management_probe_recovery')
  const concurrentInput={...input,requestId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb138',expectedRevision:recovered.revision,value:'25'}
  const concurrent=await Promise.all([repo.execute(concurrentInput),repo.execute(concurrentInput)])
  check(concurrent.filter(r=>r.replayed).length===1 && concurrent.every(r=>r.revision==='9007199254740995'),'setting_management_probe_concurrent')
  check((await repo.execute(input)).revision===recovered.revision,'setting_management_probe_historical_receipt')
  let conflict=false
  try {await repo.execute({...input,value:'2525'})}catch(e){conflict=e.message==='setting_idempotency_conflict'}
  check(conflict,'setting_management_probe_conflict')
  await c.execute("UPDATE users SET role='user' WHERE id=777994")
  let denied=false
  try {await repo.execute(input)}catch(e){denied=e.message==='setting_admin_required'}
  check(denied,'setting_management_probe_reauthorization')
  const [[stored]]=await c.query('SELECT value_text,CAST(revision AS CHAR) revision FROM system_settings WHERE id=777981')
  check(stored.value_text==='25' && stored.revision==='9007199254740995' && await count('system_setting_changes')===2 && await count('system_setting_requests')===2,'setting_management_probe_no_duplicate_write')
  const invalidCases=[
    ["UPDATE system_setting_requests SET request_sha256=? WHERE actor_user_id=777994",['g'.repeat(64)],3819],
    ["UPDATE system_setting_requests SET request_id=? WHERE actor_user_id=777994 AND revision=9007199254740994",[input.requestId.slice(0,35)+'\n'],3819],
    ['UPDATE system_setting_requests SET revision=9007199254740999 WHERE actor_user_id=777994 AND revision=9007199254740994',[],1452]
  ]
  for(const [statement,params,errno] of invalidCases) {
    await c.beginTransaction();let rejected=false
    try {await c.execute(statement,params)}catch(e){rejected=e.errno===errno}
    await c.rollback();check(rejected,'setting_management_probe_constraint')
  }
  await c.beginTransaction()
  await c.execute('DELETE FROM system_setting_requests WHERE actor_user_id=777994')
  await c.execute('DELETE FROM system_setting_changes WHERE setting_id=777981')
  await c.execute("DELETE FROM system_settings WHERE id=777981 AND namespace='smtp' AND setting_key='port'")
  await c.execute('DELETE FROM users WHERE id=777994')
  await c.commit();ownsFixture=false
  check(await count('system_settings')===0 && await count('system_setting_changes')===0 && await count('system_setting_requests')===0,'setting_management_probe_cleanup')
  const [[remaining]]=await c.query('SELECT COUNT(*) n FROM users WHERE id=777994')
  check(Number(remaining.n)===0,'setting_management_probe_actor_cleanup')
  await writePrivateJson(new URL('../receipt.json',root).pathname,{kind:'setting-management-probe/v1',identity,toolManifest:manifest,
    schema:{sqlSha256:createHash('sha256').update(sql).digest('hex'),createTable:ddl['Create Table']},fixtureOnly:true,
    realCommitThenInjectedFailure:true,recoveredWithoutRewrite:true,concurrentSameRequestOneWrite:true,historicalReceiptRecovered:true,
    payloadConflictRejected:true,revokedAdminRejected:true,invalidConstraintsRejected:invalidCases.length,fixturesCleaned:true,currentDevVueWritten:false,consumersSwitched:false})
  console.log(JSON.stringify({status:'verified',commitRecovery:true,concurrentIdempotency:true,fixturesCleaned:true}))
} catch(error) {
  console.error(JSON.stringify({code:/^setting_management_probe_[a-z_]+$/.test(error.message)?error.message:error.code??'setting_management_probe_failed'}));process.exitCode=1
} finally {
  await pool?.end()
  await c?.rollback().catch(()=>{})
  if(ownsFixture) {
    try {
      await c.beginTransaction()
      await c.execute('DELETE FROM system_setting_requests WHERE actor_user_id=777994')
      await c.execute('DELETE FROM system_setting_changes WHERE setting_id=777981')
      await c.execute("DELETE FROM system_settings WHERE id=777981 AND namespace='smtp' AND setting_key='port'")
      await c.execute('DELETE FROM users WHERE id=777994')
      await c.commit()
    } catch {process.exitCode=1;console.error('{"code":"setting_management_probe_cleanup_failed"}')}
  }
  if(lockHeld) await c.query("SELECT RELEASE_LOCK('v4-setting-writer-reference-probe')").catch(()=>{})
  await c?.end()
}
