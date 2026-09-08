import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import mysql from 'mysql2/promise'
import { hash } from './lib/v4-backfill-contract.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { tableDefinitionHash } from './lib/inplace-foundation-upgrade.mjs'
import { withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { loadAccountProjectionMigration } from './lib/inplace-account-projection-migration.mjs'
import { verifyAccountProjectionReference } from './lib/account-projection-reference-checks.mjs'
import { coordinateObserverContextMigration } from './lib/observer-context-coordinator.mjs'
import { mysqlObserverContextMigrationStore } from './lib/mysql-observer-context-migration.mjs'

// Generates canonical SHOW CREATE in a unique empty reference database. The
// restored source is only inspected. No business data is copied into reference.
const root = new URL('../', import.meta.url), target = 'dev_vue_m1_source_20260907_02'
const reference = 'dev_vue_projection_reference_' + randomBytes(12).toString('hex')
const parents = [
  { table: 'users', columnType: 'int', charset: null, collation: null, type: 'INT' },
  { table: 'trading_accounts', columnType: 'bigint unsigned', charset: null, collation: null, type: 'BIGINT UNSIGNED' },
  { table: 'terminal_profiles', columnType: 'varchar(128)', charset: 'ascii', collation: 'ascii_bin', type: 'VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin' },
  { table: 'trading_account_ownership_intervals', columnType: 'char(36)', charset: 'ascii', collation: 'ascii_bin', type: 'CHAR(36) CHARACTER SET ascii COLLATE ascii_bin' },
]
let connection, output, phase = 'arguments', created = false
try {
  const [mode, rootProofPath, destination] = process.argv.slice(2)
  assert.equal(mode, '--capture-restored-only')
  assert.ok(process.argv.length === 5 && isAbsolute(rootProofPath) && isAbsolute(destination) && rootProofPath !== destination)
  output = await open(destination, 'wx', 0o600)
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.equal(credentials.host, '127.0.0.1'); assert.equal(credentials.user, 'root')
  assert.ok(Number.isInteger(credentials.port) && credentials.port > 1024 && credentials.port < 65536)
  connection = await mysql.createConnection({ host: credentials.host, port: credentials.port, user: credentials.user, password: credentials.password,
    database: target, dateStrings: true, jsonStrings: true, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false, connectTimeout: 5000 })
  await connection.query("SET SESSION time_zone='+00:00'")
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,@@version version')
  assert.equal(identity.db, target); assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  const receipt = await withInplaceUpgradeLock(connection, target, async () => {
    phase = 'verify-restored-root'
    const plan = await loadAccountProjectionMigration(root)
    const priorStore = await mysqlObserverContextMigrationStore(connection, plan.prior, root, rootProofPath, fileURLToPath(new URL('docs/architecture/terminal-route-registered-plan-20260908.json', root)), fileURLToPath(new URL('docs/architecture/account-root-registered-plan-20260908.json', root)))
    const completed = await coordinateObserverContextMigration(priorStore, plan.prior)
    assert.ok(completed.steps.every(step => step.status === 'completed'))
    const store = { snapshot: () => priorStore.priorStore.rootStore.snapshot(), history: () => priorStore.history(), proof: async () => JSON.parse(await readFile(rootProofPath, 'utf8')) }
    const before = await store.snapshot(), historyBefore = await store.history()
    const parentDefinitions = []
    for (const parent of parents) {
      const [[column]] = await connection.execute('SELECT COLUMN_TYPE columnType,CHARACTER_SET_NAME charset,COLLATION_NAME collation FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?', [parent.table, 'id'])
      assert.deepEqual(column, { columnType: parent.columnType, charset: parent.charset, collation: parent.collation })
      parentDefinitions.push({ table: parent.table, id: column })
    }
    phase = 'create-reference'
    assert.match(reference, /^dev_vue_projection_reference_[a-f0-9]{24}$/)
    // No IF NOT EXISTS: never reuse or clean a pre-existing schema.
    created = true // A lost CREATE response must report that reference may remain.
    await connection.query('CREATE DATABASE `' + reference + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci')
    await connection.query('USE `' + reference + '`')
    for (const parent of parents) await connection.query('CREATE TABLE `' + parent.table + '` (`id` ' + parent.type + ' NOT NULL, PRIMARY KEY (`id`)) ENGINE=InnoDB')
    const definitions = []
    for (const step of plan.additions) {
      phase = 'create-' + step.table
      await connection.query(step.sql)
      const [[row]] = await connection.query('SHOW CREATE TABLE `' + step.table + '`')
      const ddl = row['Create Table']
      definitions.push({ table: step.table, sourceSqlHash: hash(step.sql), ddl, schemaHash: tableDefinitionHash(ddl) })
    }
    phase = 'verify-reference-constraints'
    const constraintChecks = await verifyAccountProjectionReference(connection, reference)
    phase = 'verify-reference-empty'
    const [tables] = await connection.query('SELECT TABLE_NAME name,TABLE_TYPE tableType FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()')
    const expected = [...parents.map(p => p.table), ...plan.additions.map(s => s.table)].sort()
    assert.deepEqual(tables.map(row => row.name).sort(), expected)
    assert.ok(tables.every(row => row.tableType === 'BASE TABLE'))
    for (const table of expected) {
      const [[row]] = await connection.query('SELECT COUNT(*) count FROM `' + table + '`')
      assert.equal(String(row.count), '0')
    }
    await connection.query('USE `' + target + '`')
    phase = 'verify-source-unchanged'
    assert.deepEqual(await store.snapshot(), before); assert.deepEqual(await store.history(), historyBefore)
    phase = 'remove-owned-empty-reference'
    await connection.query('DROP DATABASE `' + reference + '`'); created = false
    const value = { kind: 'account-projection-reference/v1', observedAt: new Date().toISOString(),
      identity: { database: target, serverUuid: identity.uuid }, mysqlVersion: identity.version,
      priorProofHash: (await store.proof()).proofHash, registryHash: hash(plan.steps.map(({ id, checksum }) => ({ id, checksum }))),
      reference, referenceRemoved: true, parentDefinitions, definitions, constraintChecks,
      sourceSnapshotHash: hash(before), sourceHistoryHash: hash(historyBefore),
      captureToolHash: sha256(await readFile(new URL('scripts/capture-account-projection-reference-local.mjs', root))),
      constraintToolHash: sha256(await readFile(new URL('scripts/lib/account-projection-reference-checks.mjs', root))),
      sourceWritten: false, currentDevVueWritten: false }
    return { ...value, proofHash: hash(value) }
  })
  await output.writeFile(JSON.stringify(receipt, null, 2) + '\n'); await output.sync()
  console.log(JSON.stringify({ target, referenceRemoved: receipt.referenceRemoved, tables: receipt.definitions.map(d => d.table), proofHash: receipt.proofHash }))
} catch {
  const failure = { failed: true, code: 'account_projection_reference_failed', phase, reference, referenceMayRemain: created }
  if (output) { await output.writeFile(JSON.stringify(failure) + '\n').catch(() => {}); await output.sync().catch(() => {}) }
  console.error(JSON.stringify(failure)); process.exitCode = 1
} finally { if (connection) await connection.end().catch(() => {}); if (output) await output.close().catch(() => {}) }
