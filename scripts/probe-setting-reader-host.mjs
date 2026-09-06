import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readSetting } from '../server/dist-v4/modules/settings/infrastructure/mysql-setting-reader.js'
import { writePrivateJson } from './lib/v4-backup-io.mjs'
const root = new URL('../', import.meta.url)
const check = (ok, code) => { if (!ok) throw new Error(code) }
let c
try {
  check(process.platform === 'linux' && process.getuid() === 0, 'setting_reader_probe_scope')
  const manifest = JSON.parse(await readFile(new URL('../tools.json', root), 'utf8'))
  for (const file of manifest) {
    check(/^[a-zA-Z0-9_./-]+$/.test(file.path) && !file.path.split('/').includes('..'), 'setting_reader_probe_path')
    check(createHash('sha256').update(await readFile(new URL(file.path, root))).digest('hex') === file.sha256, 'setting_reader_probe_file')
  }
  const mysql = createRequire(import.meta.url)('/www/wwwroot/aurum-ai/node_modules/mysql2/promise.js')
  const credentials = JSON.parse(await readFile(`/proc/self/fd/${process.env.V4_BACKUP_CREDENTIAL_FD}`, 'utf8'))
  c = await mysql.createConnection({ ...credentials, database: 'dev_vue_m1_a', dateStrings: true, timezone: 'Z' })
  const [[identity]] = await c.query('SELECT DATABASE() db,@@server_uuid uuid,VERSION() version')
  check(identity.db === 'dev_vue_m1_a' && identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'setting_reader_probe_identity')
  const counts=async()=>{const [[r]]=await c.query('SELECT COUNT(*) n FROM system_settings');return String(r.n)}
  check(await counts()==='0','setting_reader_probe_reference_not_empty')
  await c.beginTransaction()
  const scope={namespace:'fixture',key:'key',expectedType:'string'}
  check((await readSetting(c,scope)).status==='missing','setting_reader_probe_missing')
  const insert=(id,key,type,value,sensitivity)=>c.execute("INSERT INTO system_settings (id,namespace,setting_key,value_type,value_text,sensitivity,created_at_utc,updated_at_utc,revision,origin) VALUES (?,'fixture',?,?,?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),'9007199254740993','native')",[id,key,type,value,sensitivity])
  await insert(777981,'key','string','','restricted')
  await insert(777982,'nullable','string',null,'restricted')
  await insert(777983,'integer','integer','9007199254740993','restricted')
  await insert(777984,'secret','credential','{"v":"1","iv":"opaque","ct":"opaque","tag":"opaque"}','secret')
  const empty=await readSetting(c,scope),nullable=await readSetting(c,{...scope,key:'nullable'})
  check(empty.status==='found'&&empty.rawValue===''&&empty.metadata.revision==='9007199254740993'&&nullable.status==='found'&&nullable.rawValue===null,'setting_reader_probe_empty_null')
  const integer=await readSetting(c,{...scope,key:'integer',expectedType:'integer'})
  check(integer.status==='found'&&integer.rawValue==='9007199254740993','setting_reader_probe_integer')
  const secret=await readSetting(c,{...scope,key:'secret',expectedType:'credential'})
  check(secret.status==='protected'&&!Object.hasOwn(secret,'rawValue')&&!JSON.stringify(secret).includes('opaque'),'setting_reader_probe_secret')
  await c.rollback();check(await counts()==='0','setting_reader_probe_rollback')
  await writePrivateJson(new URL('../receipt.json',root).pathname,{kind:'setting-reader-probe/v1',identity,toolManifest:manifest,fixtureOnly:true,missingNullEmptyDistinct:true,exactBigIntegers:true,sqlSecretRedaction:true,rolledBack:true,currentDevVueWritten:false,consumersSwitched:false})
  console.log(JSON.stringify({status:'verified',sqlSecretRedaction:true,rolledBack:true}))
} catch (error) {
  await c?.rollback().catch(() => {})
  console.error(JSON.stringify({ code: /^setting_reader_probe_[a-z_]+$/.test(error.message) ? error.message : error.code ?? 'setting_reader_probe_failed' })); process.exitCode = 1
} finally { await c?.end() }
