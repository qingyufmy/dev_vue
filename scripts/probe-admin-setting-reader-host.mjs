import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { MysqlAdminSettingReader } from '../server/dist-v4/modules/settings/infrastructure/mysql-admin-setting-reader.js'
import { writePrivateJson } from './lib/v4-backup-io.mjs'
const root = new URL('../', import.meta.url)
const check = (ok, code) => { if (!ok) throw new Error(code) }
let c,pool,changer,ownsFixture=false,lockHeld=false,releaseGate
try {
 check(process.platform==='linux' && process.getuid()===0,'admin_setting_probe_scope')
 const manifest=JSON.parse(await readFile(new URL('../tools.json',root),'utf8'))
 for(const file of manifest) {
  check(/^[a-zA-Z0-9_./-]+$/.test(file.path)&&!file.path.split('/').includes('..'),'admin_setting_probe_path')
  check(createHash('sha256').update(await readFile(new URL(file.path,root))).digest('hex')===file.sha256,'admin_setting_probe_file')
 }
 const mysql=createRequire(import.meta.url)('/www/wwwroot/aurum-ai/node_modules/mysql2/promise.js')
 const credentials=JSON.parse(await readFile(`/proc/self/fd/${process.env.V4_BACKUP_CREDENTIAL_FD}`,'utf8'))
 const options={...credentials,database:'dev_vue_m1_a',dateStrings:true,timezone:'Z'}
 c=await mysql.createConnection(options);changer=await mysql.createConnection(options)
 const [[identity]]=await c.query('SELECT DATABASE() db,@@server_uuid uuid,VERSION() version')
 check(identity.db==='dev_vue_m1_a'&&identity.uuid==='ac423207-6ef3-11f1-b302-000c29fda104','admin_setting_probe_identity')
 await c.query("SET SESSION time_zone='+00:00'")
 await changer.query('SET SESSION innodb_lock_wait_timeout=10')
 const [[lock]]=await c.query("SELECT GET_LOCK('v4-setting-writer-reference-probe',0) acquired")
 check(lock.acquired===1,'admin_setting_probe_lock');lockHeld=true
 const counts=async()=>{const [[r]]=await c.query('SELECT (SELECT COUNT(*) FROM system_settings) settings,(SELECT COUNT(*) FROM system_setting_changes) changes,(SELECT COUNT(*) FROM system_setting_requests) requests');return r}
 check(Object.values(await counts()).every(n=>Number(n)===0),'admin_setting_probe_not_empty')
 const [[actor]]=await c.query('SELECT COUNT(*) n FROM users WHERE id=777994');check(Number(actor.n)===0,'admin_setting_probe_actor_exists')
 await c.beginTransaction()
 await c.execute("INSERT INTO users (id,password,role,created_at,updated_at) VALUES (777994,'disabled-fixture','admin',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))")
 for(const [id,key,type,value,sensitivity] of [[777981,'port','integer','465','restricted'],[777982,'pass','credential','{"v":"1","iv":"opaque","ct":"opaque","tag":"opaque"}','secret']])
  await c.execute("INSERT INTO system_settings (id,namespace,setting_key,value_type,value_text,sensitivity,created_at_utc,updated_at_utc,revision,origin) VALUES (?,'smtp',?,?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),'9007199254740993','native')",[id,key,type,value,sensitivity])
 ownsFixture=true;await c.commit()
 pool=mysql.createPool({...options,connectionLimit:3})
 const repo=new MysqlAdminSettingReader(pool)
 const scope={namespace:'smtp',key:'port',expectedType:'integer'}
 const plain=await repo.read(777994,scope)
 check(plain.status==='found'&&plain.rawValue==='465'&&plain.metadata.revision==='9007199254740993','admin_setting_probe_plain')
 const secret=await repo.read(777994,{...scope,key:'pass',expectedType:'credential'})
 check(secret.status==='protected'&&!Object.hasOwn(secret,'rawValue')&&!JSON.stringify(secret).includes('opaque'),'admin_setting_probe_secret')
 let entered
 const enteredPromise=new Promise(resolve=>{entered=resolve})
 const gate=new Promise(resolve=>{releaseGate=resolve})
 let releases=0
 const pausedPool={getConnection:async()=>{
  const connection=await pool.getConnection()
  return {query:connection.query.bind(connection),beginTransaction:connection.beginTransaction.bind(connection),
   rollback:connection.rollback.bind(connection),destroy:connection.destroy.bind(connection),release:()=>{releases++;connection.release()},
   execute:async(...args)=>{const result=await connection.execute(...args);if(args[0].includes('FOR SHARE')){entered();await gate}return result}}
 }}
 const reading=new MysqlAdminSettingReader(pausedPool).read(777994,scope).then(value=>({value}),error=>({error}))
 await enteredPromise
 const [[thread]]=await changer.query('SELECT CONNECTION_ID() id')
 await changer.beginTransaction()
 const changing=changer.execute("UPDATE users SET role='user' WHERE id=777994").then(()=>({ok:true}),error=>({error}))
 let waited=false
 for(let i=0;i<50;i++) {
  const [[r]]=await c.execute('SELECT COUNT(*) n FROM performance_schema.data_lock_waits w JOIN performance_schema.threads t ON t.THREAD_ID=w.REQUESTING_THREAD_ID WHERE t.PROCESSLIST_ID=?',[thread.id])
  if(Number(r.n)>0){waited=true;break}
  await new Promise(resolve=>setTimeout(resolve,100))
 }
 check(waited,'admin_setting_probe_no_lock_wait')
 releaseGate()
 const readResult=await reading
 check(readResult.value?.status==='found'&&releases===1,'admin_setting_probe_release')
 check((await changing).ok,'admin_setting_probe_role_update');await changer.commit()
 let denied=false
 try{await repo.read(777994,scope)}catch(e){denied=e.message==='setting_admin_required'}
 check(denied,'admin_setting_probe_revoked')
 const [[stored]]=await c.query('SELECT CAST(revision AS CHAR) revision,value_text FROM system_settings WHERE id=777981')
 const beforeCleanup=await counts()
 check(stored.revision==='9007199254740993'&&stored.value_text==='465'&&Number(beforeCleanup.settings)===2&&Number(beforeCleanup.changes)===0&&Number(beforeCleanup.requests)===0,'admin_setting_probe_read_only')
 await c.beginTransaction()
 await c.execute("DELETE FROM system_settings WHERE id IN (777981,777982) AND namespace='smtp'")
 await c.execute('DELETE FROM users WHERE id=777994');await c.commit();ownsFixture=false
 check(Object.values(await counts()).every(n=>Number(n)===0),'admin_setting_probe_cleanup')
 const [[remaining]]=await c.query('SELECT COUNT(*) n FROM users WHERE id=777994');check(Number(remaining.n)===0,'admin_setting_probe_actor_cleanup')
 await writePrivateJson(new URL('../receipt.json',root).pathname,{kind:'admin-setting-reader-probe/v1',identity,toolManifest:manifest,
  fixtureOnly:true,exactPlainValueAndRevision:true,sqlCredentialRedaction:true,observedRoleChangeLockWait:true,
  readTransactionReleased:true,revokedAdminRejected:true,noReadSideWrites:true,fixturesCleaned:true,currentDevVueWritten:false,consumersSwitched:false})
 console.log(JSON.stringify({status:'verified',roleLockWait:true,secretRedacted:true,fixturesCleaned:true}))
} catch(error) {
 console.error(JSON.stringify({code:/^admin_setting_probe_[a-z_]+$/.test(error.message)?error.message:error.code??'admin_setting_probe_failed'}));process.exitCode=1
} finally {
 releaseGate?.()
 await changer?.rollback().catch(()=>{})
 await pool?.end()
 await c?.rollback().catch(()=>{})
 if(ownsFixture)try{
  await c.beginTransaction();await c.execute("DELETE FROM system_settings WHERE id IN (777981,777982) AND namespace='smtp'")
  await c.execute('DELETE FROM users WHERE id=777994');await c.commit()
 }catch{process.exitCode=1;console.error('{"code":"admin_setting_probe_cleanup_failed"}')}
 if(lockHeld)await c.query("SELECT RELEASE_LOCK('v4-setting-writer-reference-probe')").catch(()=>{})
 await changer?.end();await c?.end()
}
