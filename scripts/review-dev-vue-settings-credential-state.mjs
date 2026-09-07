import { settingsValueContracts } from './lib/v4-settings-value-contract.mjs'
import { hash } from './lib/v4-backfill-contract.mjs'
import { paymentConfigSourceFields } from './lib/v4-payment-config-source.mjs'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import { loadSettingRequestCoordinator } from './lib/inplace-setting-request-schema.mjs'
import { coordinateInplaceSchema } from './lib/inplace-schema-coordinator.mjs'
import { verifyInplaceJournal } from './lib/mysql-inplace-column-store.mjs'
import { verifyOriginalSchemaWithReferralRules } from './lib/inplace-referral-rule-schema.mjs'

const root = new URL('../', import.meta.url)
const reportPath = new URL('docs/migration/dev-vue-settings-credential-state-review-20260907.json', root)
const check = (ok, code) => { if (!ok) throw new Error(code) }
let connection
try {
  const [mode] = process.argv.slice(2)
  check(process.argv.length === 3 && ['--write', '--verify'].includes(mode), 'settings_credential_state_arguments')
  const previous = mode === '--verify' ? JSON.parse(await readFile(reportPath, 'utf8')) : null
  const backup = JSON.parse(await readFile(new URL('docs/migration/dev-vue-inplace-backup-20260906.json', root), 'utf8'))
  const plan = await loadSettingRequestCoordinator(root)
  const env = parse(await readFile(new URL('server/.env', root)))
  check(env.MYSQL_DATABASE === 'dev_vue', 'settings_credential_state_database')
  connection = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: 'dev_vue', dateStrings: true, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true })
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  check(identity.db === 'dev_vue' && identity.uuid === backup.serverUuid, 'settings_credential_state_identity')
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  check(await verifyInplaceJournal(connection), 'settings_credential_state_journal')
  check((await coordinateInplaceSchema(plan.store(connection), plan)).structureComplete, 'settings_credential_state_schema')
  await verifyOriginalSchemaWithReferralRules(connection, backup.schemaSha256, [...new Set(plan.steps.filter(s => !s.column).map(s => s.table))], plan.referralRuleReference)
  const inventory = JSON.parse(await readFile(new URL('docs/migration/dev-vue-settings-inventory-20260907.json', root)))
  const rules = settingsValueContracts().filter(rule => rule.type === 'credential'), readable = rules
  const clauses = readable.map(() => '(category=? AND `key`=?)').join(' OR ')
  const [rows] = await connection.execute(`SELECT CAST(id AS CHAR) id,category,\`key\`,CASE WHEN value IS NULL THEN 'null' WHEN OCTET_LENGTH(value)=0 THEN 'empty'
    WHEN JSON_VALID(value) THEN CASE WHEN JSON_TYPE(value)='OBJECT'
      AND JSON_TYPE(JSON_EXTRACT(value,'$.v'))='STRING' AND CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(value,'$.v')))>0
      AND JSON_TYPE(JSON_EXTRACT(value,'$.iv'))='STRING' AND CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(value,'$.iv')))>0
      AND JSON_TYPE(JSON_EXTRACT(value,'$.ct'))='STRING' AND CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(value,'$.ct')))>0
      AND JSON_TYPE(JSON_EXTRACT(value,'$.tag'))='STRING' AND CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(value,'$.tag')))>0
      THEN 'envelope_shape' ELSE 'unprotected_or_invalid' END
    ELSE 'unprotected_or_invalid' END credential_state,
    DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s.%f') created_at,DATE_FORMAT(updated_at,'%Y-%m-%d %H:%i:%s.%f') updated_at,
    SHA2(CAST(JSON_ARRAY(id,category,\`key\`,value,label,sort_order,DATE_FORMAT(created_at,'%Y-%m-%d %H:%i:%s.%f'),DATE_FORMAT(updated_at,'%Y-%m-%d %H:%i:%s.%f')) AS CHAR CHARACTER SET utf8mb4),256) rowSha256
    FROM system_config WHERE ${clauses} ORDER BY id`, readable.flatMap(rule => [rule.namespace, rule.key]))
  check(rows.length === readable.length, 'settings_credential_state_coverage')
  const seen = new Set()
  const entries = rows.map(row => {
    const identityKey = `${row.category}/${row.key}`
    check(!seen.has(identityKey), 'settings_credential_state_duplicate'); seen.add(identityKey)
    const original = inventory.result.entries.find(entry => entry.id === row.id)
    check(original && original.rowSha256 === row.rowSha256, 'settings_credential_state_source_changed')
    const rule = rules.find(rule=>rule.namespace===row.category&&rule.key===row.key)
    check(['null', 'empty', 'envelope_shape', 'unprotected_or_invalid'].includes(row.credential_state), 'settings_credential_state_unknown')
    const inspection = { state: row.credential_state, valueNotRead: true, decryptionVerified: false,
      compatible: row.credential_state === 'empty',
      needs: row.credential_state === 'empty' ? ['preserve_not_configured']
        : row.credential_state === 'null' ? ['null_policy']
        : row.credential_state === 'envelope_shape' ? ['keyring_restore_and_decryption_proof']
        : ['credential_protection_review'] }
    const time = raw => ({raw,status:raw===null?'source_null':'offset_evidence_required'})
    return {sourceId:row.id,namespace:row.category,key:row.key,sourceRowSha256:row.rowSha256,type:rule.type,
      inspection,createdAt:time(row.created_at),updatedAt:time(row.updated_at),readyForBackfill:false}

  })
  const result = { version: 'settings-credential-state-review/v1', entries, sourceHash: hash(entries),
    credentialKeysExcluded: rules.filter(rule => rule.exposure === 'secret').map(rule => ({ namespace: rule.namespace, key: rule.key })),
    compatibleRows: entries.filter(entry => entry.inspection.compatible).length, nonNullTimeRows: entries.filter(entry=>entry.createdAt.raw!==null||entry.updatedAt.raw!==null).length, readyRows:0, valuesDecrypted: false, semanticAcceptanceVerified: false }
  const [columns] = await connection.execute('SELECT COLUMN_NAME name,COLUMN_TYPE type,IS_NULLABLE nullable,COLUMN_DEFAULT defaultValue,COLLATION_NAME collationName FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', ['system_config'])
  check(columns.length === 8 && columns.every(column => Object.hasOwn(paymentConfigSourceFields, column.name)), 'settings_credential_state_column_coverage')
  const [indexes] = await connection.execute('SELECT INDEX_NAME name,NON_UNIQUE nonUnique,SEQ_IN_INDEX position,COLUMN_NAME columnName FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY INDEX_NAME,SEQ_IN_INDEX', ['system_config'])
  const referenceFiles = []
  for (const path of ['server/system-config-secrets.js', 'server/admin/content-system.js', 'server/routes/config.js', 'server/storage/storage-config.js', 'server/sms.js', 'server/system-email.js']) {
    const bytes = await readFile(new URL(path, 'file:///D:/dev_codex/wall-street-skill-local/'))
    referenceFiles.push({ path, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  const report = { kind: 'settings-credential-state/v1', identity, schemaSteps: plan.steps.length,
    columns, indexes, result, referenceFiles, sourceDatabaseWritten: false, businessConsumersSwitched: false }
  await connection.rollback()
  if (mode === '--write') await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  else check(JSON.stringify(previous) === JSON.stringify(report), 'settings_credential_state_review_changed')
  console.log(JSON.stringify({ status: 'verified', rows: result.entries.length, states: result.entries.map(entry => ({ namespace: entry.namespace, key: entry.key, state: entry.inspection.state })), databaseWrites: 0 }))
} catch (error) {
  console.error(JSON.stringify({ code: /^settings_credential_state_[a-z_]+$/.test(error.message) ? error.message : 'settings_credential_state_review_failed' }))
  process.exitCode = 1
} finally {
  if (connection) { await connection.rollback().catch(() => {}); await connection.end().catch(() => {}) }
}
