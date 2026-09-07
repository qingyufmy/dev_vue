import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { updateSettingInTransaction } from '../server/dist-v4/modules/settings/infrastructure/mysql-setting-writer.js'
import { writePrivateJson } from './lib/v4-backup-io.mjs'
const root = new URL('../', import.meta.url)
const check = (ok, code) => { if (!ok) throw new Error(code) }
let c, other, ownsFixture = false, lockHeld = false
try {
  check(process.platform === 'linux' && process.getuid() === 0, 'setting_writer_probe_scope')
  const manifest = JSON.parse(await readFile(new URL('../tools.json', root), 'utf8'))
  for (const file of manifest) {
    check(/^[a-zA-Z0-9_./-]+$/.test(file.path) && !file.path.split('/').includes('..'), 'setting_writer_probe_path')
    check(createHash('sha256').update(await readFile(new URL(file.path, root))).digest('hex') === file.sha256, 'setting_writer_probe_file')
  }
  const mysql = createRequire(import.meta.url)('/www/wwwroot/aurum-ai/node_modules/mysql2/promise.js')
  const credentials = JSON.parse(await readFile(`/proc/self/fd/${process.env.V4_BACKUP_CREDENTIAL_FD}`, 'utf8'))
  const connect = () => mysql.createConnection({ ...credentials, database:'dev_vue_m1_a', dateStrings:true, timezone:'Z' })
  c = await connect(); other = await connect()
  for (const connection of [c,other]) {
    const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
    check(identity.db==='dev_vue_m1_a' && identity.uuid==='ac423207-6ef3-11f1-b302-000c29fda104','setting_writer_probe_identity')
    await connection.query("SET SESSION time_zone='+00:00'")
    await connection.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    await connection.query('SET SESSION innodb_lock_wait_timeout=10')
  }
  const [[lock]] = await c.query("SELECT GET_LOCK('v4-setting-writer-reference-probe',0) acquired")
  check(lock.acquired===1,'setting_writer_probe_lock'); lockHeld=true
  const count = async table => {check(['system_settings','system_setting_changes'].includes(table),'setting_writer_probe_table');const [[r]]=await c.query(`SELECT COUNT(*) n FROM ${table}`);return Number(r.n)}
  check(await count('system_settings')===0 && await count('system_setting_changes')===0,'setting_writer_probe_not_empty')
  const [[actor]] = await c.query('SELECT COUNT(*) n FROM users WHERE id=777994')
  check(Number(actor.n)===0,'setting_writer_probe_actor_exists')
  await c.beginTransaction()
  await c.execute("INSERT INTO users (id,password,created_at,updated_at) VALUES (777994,'disabled-fixture',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))")
  await c.execute("INSERT INTO system_settings (id,namespace,setting_key,value_type,value_text,sensitivity,label,created_at_utc,updated_at_utc,revision,origin) VALUES (777981,'writer_fixture','enabled','boolean','false','restricted','fixture',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),'9007199254740993','native')")
  ownsFixture=true; await c.commit()
  const input={namespace:'writer_fixture',key:'enabled',expectedType:'boolean',expectedRevision:'9007199254740993',value:'true',requestId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaa135',actorUserId:777994}
  const policy=v=>v.namespace==='writer_fixture' && v.key==='enabled' && v.expectedType==='boolean' && ['true','false'].includes(v.value)
  // Establish an old consistent-read snapshot before the first writer commits.
  await other.beginTransaction()
  const [[old]] = await other.query('SELECT CAST(revision AS CHAR) revision FROM system_settings WHERE id=777981')
  check(old.revision===input.expectedRevision,'setting_writer_probe_snapshot')
  await c.beginTransaction()
  const first=await updateSettingInTransaction(c,input,policy)
  check(first.revision==='9007199254740994','setting_writer_probe_precision')
  const [[thread]] = await other.query('SELECT CONNECTION_ID() id')
  let settled=false
  const pending=updateSettingInTransaction(other,{...input,requestId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbb135'},policy)
    .then(()=>({ok:true}),e=>({ok:false,code:e.message})).finally(()=>{settled=true})
  let waiting=false
  for(let attempt=0;attempt<50;attempt++) {
    const [[r]]=await c.execute(`SELECT COUNT(*) n FROM performance_schema.data_lock_waits w
      JOIN performance_schema.threads t ON t.THREAD_ID=w.REQUESTING_THREAD_ID WHERE t.PROCESSLIST_ID=?`,[thread.id])
    if(Number(r.n)>0){waiting=true;break}
    if(settled) break
    await new Promise(resolve=>setTimeout(resolve,100))
  }
  check(waiting,'setting_writer_probe_no_observed_wait')
  await c.commit()
  const second=await pending
  check(!second.ok && second.code==='setting_revision_conflict','setting_writer_probe_stale_writer')
  await other.rollback()
  const [[stored]]=await c.query('SELECT value_text,CAST(revision AS CHAR) revision,label FROM system_settings WHERE id=777981')
  check(stored.value_text==='true' && stored.revision===first.revision && stored.label==='fixture','setting_writer_probe_committed')
  const [audit]=await c.query('SELECT CAST(revision AS CHAR) revision,previous_sha256,current_sha256 FROM system_setting_changes WHERE setting_id=777981')
  check(audit.length===1 && audit[0].revision===first.revision && audit[0].previous_sha256!==audit[0].current_sha256,'setting_writer_probe_audit')
  // Reusing the unique request produces a real audit INSERT failure after UPDATE.
  await c.beginTransaction()
  let duplicate=false
  try {await updateSettingInTransaction(c,{...input,expectedRevision:first.revision,value:'false'},policy)}
  catch(e){duplicate=e.code==='ER_DUP_ENTRY'}
  check(duplicate,'setting_writer_probe_duplicate_not_rejected')
  await c.rollback()
  const [[afterRollback]]=await c.query('SELECT value_text,CAST(revision AS CHAR) revision FROM system_settings WHERE id=777981')
  check(afterRollback.value_text==='true' && afterRollback.revision===first.revision && await count('system_setting_changes')===1,'setting_writer_probe_atomic_rollback')
  await c.beginTransaction()
  await c.execute('DELETE FROM system_setting_changes WHERE setting_id=777981')
  await c.execute("DELETE FROM system_settings WHERE id=777981 AND namespace='writer_fixture' AND setting_key='enabled'")
  await c.execute('DELETE FROM users WHERE id=777994')
  await c.commit(); ownsFixture=false
  check(await count('system_settings')===0 && await count('system_setting_changes')===0,'setting_writer_probe_cleanup')
  const [[remaining]]=await c.query('SELECT COUNT(*) n FROM users WHERE id=777994')
  check(Number(remaining.n)===0,'setting_writer_probe_actor_cleanup')
  await writePrivateJson(new URL('../receipt.json',root).pathname,{kind:'setting-writer-probe/v1',toolManifest:manifest,database:'dev_vue_m1_a',serverUuid:'ac423207-6ef3-11f1-b302-000c29fda104',fixtureOnly:true,observedConcurrentLockWait:true,staleSnapshotRejected:true,exactBigRevision:true,auditCommitted:true,auditFailureRolledBack:true,fixturesCleaned:true,currentDevVueWritten:false,consumersSwitched:false})
  console.log(JSON.stringify({status:'verified',concurrentLockWait:true,atomicRollback:true,fixturesCleaned:true}))
} catch(error) {
  console.error(JSON.stringify({code:/^setting_writer_probe_[a-z_]+$/.test(error.message)?error.message:error.code??'setting_writer_probe_failed'}));process.exitCode=1
} finally {
  await other?.rollback().catch(()=>{})
  await c?.rollback().catch(()=>{})
  if(ownsFixture) {
    try {
      await c.beginTransaction()
      await c.execute('DELETE FROM system_setting_changes WHERE setting_id=777981')
      await c.execute("DELETE FROM system_settings WHERE id=777981 AND namespace='writer_fixture' AND setting_key='enabled'")
      await c.execute('DELETE FROM users WHERE id=777994')
      await c.commit()
    } catch {process.exitCode=1;console.error('{"code":"setting_writer_probe_cleanup_failed"}')}
  }
  if(lockHeld) await c.query("SELECT RELEASE_LOCK('v4-setting-writer-reference-probe')").catch(()=>{})
  await other?.end();await c?.end()
}
