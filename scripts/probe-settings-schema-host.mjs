import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
const check = (ok, code) => { if (!ok) throw Error(code) }, sha = value => createHash('sha256').update(value).digest('hex')
let c
try {
  check(process.platform === 'linux' && process.getuid() === 0, 'settings_probe_scope')
  const mysql = createRequire(import.meta.url)('/www/wwwroot/aurum-ai/node_modules/mysql2/promise.js')
  c = await mysql.createConnection({ ...JSON.parse(await readFile(`/proc/self/fd/${process.env.V4_BACKUP_CREDENTIAL_FD}`)), database: 'dev_vue_m1_a', dateStrings: true })
  const [[identity]] = await c.query('SELECT DATABASE() db,@@server_uuid uuid,VERSION() version')
  check(identity.db === 'dev_vue_m1_a' && identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'settings_probe_identity')
  const definitions = []
  for (const [table, file] of [['system_settings','018_system_settings.sql'],['system_setting_changes','019_system_setting_changes.sql']]) {
    const [[exists]] = await c.execute('SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [table])
    check(Number(exists.n) === 0, 'settings_probe_exists')
    const sql = await readFile(new URL(file, import.meta.url), 'utf8'); await c.query(sql)
    const [[row]] = await c.query(`SHOW CREATE TABLE ${table}`)
    definitions.push({ table, file, sourceSqlSha256: sha(sql), ddl: row['Create Table'] })
  }
  await c.beginTransaction()
  const base = { id:777990, namespace:'fixture', setting_key:'enabled', value_type:'boolean', value_text:'true', sensitivity:'restricted',
    label:null, sort_order:null, created_at_utc:'2026-09-07 00:00:00.123', updated_at_utc:'2026-09-07 00:00:00.456', revision:'9007199254740993', origin:'native', migration_run_id:null, source_sha256:null, imported_at_utc:null }
  const fields = Object.keys(base), insert = row => c.execute(`INSERT INTO system_settings (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`, fields.map(key => row[key]))
  await insert(base)
  await insert({ ...base,id:777991,setting_key:'items',value_type:'json_array',value_text:'[]' })
  await insert({ ...base,id:777992,setting_key:'credential',value_type:'credential',value_text:'{"v":"1","iv":"fixture","tag":"fixture","ct":"fixture"}',sensitivity:'secret' })
  const rejected = []
  for (const [name, patch] of [['identity_space',{namespace:'fixture '}],['uppercase',{setting_key:'Upper'}],['type',{value_type:'unknown'}],['boolean',{value_text:'1'}],['integer',{value_type:'integer',value_text:'01'}],['invalid_json',{value_type:'json_array',value_text:'broken'}],['json_object',{value_type:'json_array',value_text:'{}'}],['plaintext_secret',{value_type:'credential',sensitivity:'secret',value_text:'plain'}],['public_secret',{value_type:'credential',sensitivity:'public',value_text:''}],['revision',{revision:'0'}],['native_time',{created_at_utc:null}],['origin_space',{origin:'native '}],['legacy_missing',{origin:'legacy_import'}]]) {
    let code; try { await insert({ ...base,id:777993,setting_key:'negative',...patch }) } catch (e) { code=e.code }
    check(code === 'ER_CHECK_CONSTRAINT_VIOLATED', 'settings_probe_negative'); rejected.push(name)
  }
  const [[actorExists]] = await c.query('SELECT COUNT(*) n FROM users WHERE id=777994')
  check(Number(actorExists.n)===0,'settings_probe_actor_exists')
  await c.execute("INSERT INTO users (id,password,created_at,updated_at) VALUES (777994,'disabled-fixture',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))")
  const actor = { id:777994 }
  await c.execute("INSERT INTO system_setting_changes VALUES (?,2,'ffffffff-ffff-4fff-8fff-ffffffffff26',?,?,?,?)",[base.id,actor.id,'a'.repeat(64),'b'.repeat(64),'2026-09-07 00:00:00.789'])
  let duplicate; try { await c.execute("INSERT INTO system_setting_changes VALUES (?,3,'ffffffff-ffff-4fff-8fff-ffffffffff26',?,?,?,?)",[base.id,actor.id,'a'.repeat(64),'b'.repeat(64),'2026-09-07 00:00:00.789']) } catch(e) { duplicate=e.code }
  check(duplicate === 'ER_DUP_ENTRY','settings_probe_idempotency')
  const [[saved]] = await c.query('SELECT CAST(revision AS CHAR) revision,created_at_utc FROM system_settings WHERE id=777990')
  check(saved.revision === base.revision && saved.created_at_utc === base.created_at_utc,'settings_probe_precision')
  await c.rollback()
  const [[counts]] = await c.query('SELECT (SELECT COUNT(*) FROM system_settings) settings,(SELECT COUNT(*) FROM system_setting_changes) changes')
  check(Number(counts.settings)===0 && Number(counts.changes)===0,'settings_probe_cleanup')
  await writeFile(new URL('receipt.json',import.meta.url),JSON.stringify({kind:'settings-schema-probe/v1',identity,definitions,rejected,acceptedRows:3,auditRequestUnique:true,exactPrecision:true,rolledBack:true,counts,currentDevVueWritten:false},null,2)+'\n',{flag:'wx',mode:0o600})
  console.log(JSON.stringify({status:'verified',rejected:rejected.length,rolledBack:true}))
} catch(e) { await c?.rollback().catch(()=>{});console.error(JSON.stringify({code:e.code??e.message}));process.exitCode=1 } finally { await c?.end() }
