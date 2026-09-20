import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import mysql from 'mysql2/promise'
import { loadBridgeInstallationUpgrade } from './lib/bridge-installation-upgrade.mjs'
import { tableDefinitionHash } from './lib/inplace-foundation-upgrade.mjs'
import { sha256, splitSqlStatements } from './lib/v4-migration-plan.mjs'
import { mysqlColumnStore } from './lib/mysql-inplace-column-store.mjs'
import { hash } from './lib/v4-backfill-contract.mjs'

const root = new URL('../', import.meta.url), plan = await loadBridgeInstallationUpgrade(root)
const file = await open(process.argv[2], 'wx', 0o600)
const raw = await readFile(new URL('server/db/migrations/corrections/080-bridge-installation-request-limits-collation.sql', root))
const [sql, ...extra] = splitSqlStatements(raw.toString('utf8'))
assert.equal(extra.length, 0)
assert.equal(sql, 'ALTER TABLE bridge_installation_request_limits DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci')
const report = { passed: false, kind: 'bridge-installation-collation-reference/v1', originalStepId: plan.added[0].id,
  originalStepChecksum: plan.added[0].checksum, correctionFileSha256: sha256(raw), correctionSqlSha256: sha256(sql), sql }
let source, admin, reference, created = false
const name = 'dev_vue_workflow_schema_ref_' + randomBytes(16).toString('hex')
const ddl = async db => { const [[row]] = await db.query('SHOW CREATE TABLE bridge_installation_request_limits'); return row['Create Table'] }
try {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.ok(credentials.host === '127.0.0.1' && credentials.port === 13316 && credentials.user === 'root')
  const options = { ...credentials, timezone: 'Z', dateStrings: true, jsonStrings: true, supportBigNumbers: true, bigNumberStrings: true }
  source = await mysql.createConnection({ ...options, database: 'dev_vue' })
  await source.query('SET SESSION TRANSACTION READ ONLY')
  const [[identity]] = await source.query('SELECT @@server_uuid uuid,DATABASE() db')
  assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104'); assert.equal(identity.db, 'dev_vue')
  const beforeHistory = await mysqlColumnStore(source, true).history()
  assert.equal(beforeHistory.length, 268)
  assert.equal(beforeHistory.find(row => row.id === report.originalStepId)?.status, 'started')
  assert.equal(beforeHistory.find(row => row.id === report.originalStepId)?.checksum, report.originalStepChecksum)
  const actual = await ddl(source), canonical = plan.definitions.bridge_installation_request_limits
  assert.equal(actual, canonical.replace('COLLATE=utf8mb4_unicode_ci', 'COLLATE=utf8mb4_general_ci'))
  report.actualBeforeTableHash = tableDefinitionHash(actual)
  report.expectedAfterTableHash = tableDefinitionHash(canonical)
  const [[empty]] = await source.query('SELECT COUNT(*) n FROM bridge_installation_request_limits'); assert.equal(Number(empty.n), 0)
  admin = await mysql.createConnection(options)
  const [existing] = await admin.execute('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [name])
  assert.equal(existing.length, 0)
  created = true
  await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`)
  reference = await mysql.createConnection({ ...options, database: name })
  await reference.query(plan.added[0].sql)
  assert.equal(tableDefinitionHash(await ddl(reference)), report.actualBeforeTableHash)
  let ddlCount = 0
  try { await reference.query(sql); ddlCount++; throw Error('injected_ack_loss') }
  catch (error) { assert.equal(error.message, 'injected_ack_loss') }
  assert.equal(tableDefinitionHash(await ddl(reference)), report.expectedAfterTableHash)
  // Recovery reads the committed definition and does not submit ALTER again.
  if (tableDefinitionHash(await ddl(reference)) !== report.expectedAfterTableHash) { await reference.query(sql); ddlCount++ }
  assert.equal(ddlCount, 1)
  const [columns] = await reference.query('SELECT COLUMN_NAME name,COLLATION_NAME collation FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY ORDINAL_POSITION')
  assert.equal(columns.find(row => row.name === 'ip_hash').collation, 'ascii_bin')
  assert.equal(await ddl(source), actual)
  assert.equal(hash(await mysqlColumnStore(source, true).history()), hash(beforeHistory))
  Object.assign(report, { passed: true, ddlAckLossRecovered: true, replayNoDDL: true, asciiColumnPreserved: true,
    sourceSchemaAndJournalUnchanged: true, existingDatabaseWrites: 0 })
} catch (error) { report.errorCode = error.code ?? error.name; report.passed = false; process.exitCode = 1 }
finally {
  if (reference) await reference.end()
  if (created && admin) {
    try { await admin.query(`DROP DATABASE \`${name}\``); report.referenceDatabaseRemoved = true }
    catch { report.passed = false; process.exitCode = 1 }
  }
  if (source) await source.end()
  if (admin) await admin.end()
  report.observedAt = new Date().toISOString()
  await file.writeFile(JSON.stringify(report, null, 2) + '\n'); await file.close()
  console.log(JSON.stringify(report))
}
