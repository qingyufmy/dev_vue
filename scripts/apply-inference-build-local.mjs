import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import mysql from 'mysql2/promise'
import { hash } from './lib/v4-backfill-contract.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { loadInferenceBuildUpgrade } from './lib/inference-build-upgrade.mjs'
import { readInferenceBuildRehearsalEvidence } from './lib/inference-build-rehearsal-evidence.mjs'
import { coordinateInplaceSchema } from './lib/inplace-schema-coordinator.mjs'
import { mysqlColumnStore, verifyInplaceJournal, withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { validateColumnHistory } from './lib/dev-vue-column-upgrade.mjs'
import { readAccountRootSnapshot } from './lib/mysql-account-root-snapshot.mjs'
import { tableDefinitionHash } from './lib/inplace-foundation-upgrade.mjs'

const [mode, destination] = process.argv.slice(2)
assert.ok(['--prepare', '--apply', '--replay'].includes(mode) && isAbsolute(destination ?? '') && process.argv.length === 4)
const root = new URL('../', import.meta.url), json = async path => JSON.parse(await readFile(path, 'utf8'))
const proofBytes = await readFile(new URL('docs/architecture/inference-restored-baseline-20260910.json', root))
const proof = JSON.parse(proofBytes), target = 'dev_vue'
assert.ok(proof.passed && proof.source === target && proof.target === 'dev_vue_m1_source_20260910_02')
assert.equal(proof.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
const loaded = await loadInferenceBuildUpgrade(root), plan = { steps: loaded.steps, transitions: loaded.transitions }
assert.equal(hash(plan), proof.planHash)
const rehearsal = await readInferenceBuildRehearsalEvidence(root, loaded)
assert.equal(rehearsal.baselineProofSha256, sha256(proofBytes))
const receiptBytes = await readFile(join(proof.archiveDirectory, 'receipt.json'))
assert.equal(sha256(receiptBytes), proof.receiptSha256); assert.equal(proof.receiptSha256, rehearsal.receiptSha256)
const receipt = JSON.parse(receiptBytes)
assert.ok(receipt.status === 'verified' && receipt.source === target && receipt.target === proof.target && receipt.serverUuid === proof.serverUuid)
const digest = createHash('sha256'); let size = 0
for await (const chunk of createReadStream(join(proof.archiveDirectory, 'source.sql.enc'))) { digest.update(chunk); size += chunk.length }
assert.equal(size, receipt.artifact.ciphertext.bytes); assert.equal(digest.digest('hex'), receipt.artifact.ciphertext.sha256)
const key = await readFile(join(receipt.keyDirectory, 'backup.key'))
try { assert.equal(key.length, 32) } finally { key.fill(0) }
const source = await json(join(proof.archiveDirectory, 'source-snapshot.json'))
assert.equal(hash(source), receipt.tablesSha256)
const paths = ['scripts/apply-inference-build-local.mjs', 'scripts/run-inference-current-local.py',
  'scripts/lib/inference-build-rehearsal-evidence.mjs', 'scripts/lib/inference-build-upgrade.mjs',
  'scripts/lib/inplace-schema-coordinator.mjs', 'scripts/lib/mysql-inplace-column-store.mjs',
  'scripts/lib/dev-vue-column-upgrade.mjs', 'scripts/lib/mysql-account-root-snapshot.mjs',
  'scripts/lib/inplace-column-evidence.mjs', 'scripts/lib/inplace-foundation-upgrade.mjs', loaded.added[0].source]
const tools = await Promise.all(paths.map(async path => ({ path, sha256: sha256(await readFile(new URL(path, root))) })))
const binding = { planHash: hash(plan), tools, rehearsalHash: hash(rehearsal), baselineProofSha256: sha256(proofBytes),
  receiptSha256: proof.receiptSha256, sourceSnapshotHash: hash(source) }
const baselinePath = join(proof.archiveDirectory, 'inference-build-current-baseline-v1.json')
const names = Object.keys(loaded.finalTableHashes), ids = loaded.added.map(step => step.id)
const output = await open(destination, 'wx', 0o600)
const report = { kind: 'inference-build-current-upgrade/v1', passed: false, mode, target, serverUuid: proof.serverUuid,
  ...binding, ddlAttempted: 0, ddlAcknowledged: 0, executedStepIds: [], businessDataWrites: 0, restoredDatabaseWrites: 0 }
let connection
try {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credential = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.ok(credential.host === '127.0.0.1' && credential.port === 13316 && credential.user === 'root')
  connection = await mysql.createConnection({ ...credential, database: target, timezone: 'Z', dateStrings: true,
    jsonStrings: true, supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false })
  await connection.query("SET SESSION time_zone='+00:00'")
  await withInplaceUpgradeLock(connection, target, async () => {
    const guard = async () => {
      const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,@@session.time_zone timezone,@@innodb_force_recovery recovery,CURRENT_USER() principal')
      assert.equal(identity.db, target); assert.equal(identity.uuid, proof.serverUuid)
      assert.equal(identity.timezone, '+00:00'); assert.equal(Number(identity.recovery), 0); assert.ok(identity.principal.startsWith('root@'))
      const [[lock]] = await connection.execute('SELECT IS_USED_LOCK(?) owner,CONNECTION_ID() currentId', [`aurum:inplace:${target}`])
      assert.equal(String(lock.owner), String(lock.currentId))
      const [[clients]] = await connection.query('SELECT COUNT(*) n FROM information_schema.PROCESSLIST WHERE DB=DATABASE() AND ID<>CONNECTION_ID()')
      assert.equal(Number(clients.n), 0, 'other_database_clients')
    }
    const tableHash = async name => {
      assert.ok(names.includes(name))
      const [tables] = await connection.execute('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [name])
      if (!tables.length) return null
      const [triggers] = await connection.execute('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?', [name])
      assert.equal(triggers.length, 0)
      const [[row]] = await connection.query(`SHOW CREATE TABLE \`${name}\``)
      return tableDefinitionHash(row['Create Table'])
    }
    const snapshot = async () => {
      await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
      try { return (await readAccountRootSnapshot(connection)).tables } finally { await connection.rollback() }
    }
    const journal = mysqlColumnStore(connection, true)
    await guard(); assert.ok(await verifyInplaceJournal(connection))
    let baseline
    if (mode === '--prepare') {
      const history = await journal.history(), current = await snapshot()
      assert.deepEqual(history, proof.observations.find(row => row.database === target).history)
      assert.equal(hash(current), proof.observations.find(row => row.database === target).snapshotHash, 'source_changed_since_backup')
      assert.equal(current.length, 258)
      for (const name of names) assert.equal(await tableHash(name), null)
      baseline = { kind: 'inference-build-current-baseline/v1', target, ...binding, history, snapshot: current }
      const file = await open(baselinePath, 'wx', 0o600)
      try { await file.writeFile(JSON.stringify(baseline, null, 2) + '\n'); await file.sync() } finally { await file.close() }
    } else baseline = await json(baselinePath)
    assert.equal(baseline.kind, 'inference-build-current-baseline/v1'); assert.equal(baseline.target, target)
    for (const [key, value] of Object.entries(binding)) assert.deepEqual(baseline[key], value)
    const protectedTables = rows => rows.filter(row => row.name !== 'database_upgrade_steps_v4' && !names.includes(row.name))
    const verify = async () => {
      await guard(); assert.ok(await verifyInplaceJournal(connection))
      const history = await journal.history(); validateColumnHistory(history, loaded.steps)
      assert.deepEqual(history.filter(row => !ids.includes(row.id)), baseline.history)
      const current = await snapshot()
      assert.equal(hash(protectedTables(current)), hash(protectedTables(baseline.snapshot)), 'protected_tables_changed')
      assert.equal(current.find(row => row.name === 'database_upgrade_steps_v4').ddl, baseline.snapshot.find(row => row.name === 'database_upgrade_steps_v4').ddl)
      for (const row of current.filter(row => names.includes(row.name))) assert.equal(Number(row.rows), 0)
      for (const required of loaded.parentRequirements) {
        const [columns] = await connection.execute('SELECT COLUMN_TYPE type,COLLATION_NAME collation,IS_NULLABLE nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?', [required.table, required.column])
        assert.deepEqual(columns, [{ type: required.type, collation: required.collation, nullable: required.nullable }])
      }
      return current
    }
    await verify()
    const checkStep = step => assert.ok(loaded.added.some(s => s.id === step.id && s.checksum === step.checksum))
    const store = { history: () => journal.history(), tableHash,
      async begin(step) { await guard(); checkStep(step); await journal.begin(step) },
      async execute(sql) {
        await guard(); const step = loaded.added.find(s => s.sql === sql); assert.ok(step)
        report.ddlAttempted++; report.executedStepIds.push(step.id)
        await connection.query(sql); report.ddlAcknowledged++
      },
      async complete(step) { await guard(); checkStep(step); await journal.complete(step) } }
    const inspect = async () => (await coordinateInplaceSchema(store, plan)).steps.map(step => step.status)
    report.beforeStates = await inspect()
    if (mode === '--prepare') assert.ok(report.beforeStates.every(state => state === 'pending'))
    if (mode === '--replay') assert.ok(report.beforeStates.every(state => state === 'completed'))
    report.result = await coordinateInplaceSchema(store, plan, { apply: mode !== '--prepare' })
    report.afterStates = await inspect()
    const expectedDdl = mode === '--apply' ? report.beforeStates.filter(state => state === 'pending').length : 0
    assert.equal(report.ddlAttempted, expectedDdl); assert.equal(report.ddlAcknowledged, expectedDdl)
    if (mode !== '--prepare') assert.ok(report.afterStates.every(state => state === 'completed'))
    const final = await verify()
    report.history = await journal.history(); report.protectedSnapshotHash = hash(protectedTables(final))
    report.protectedTableCount = protectedTables(final).length; report.totalTableCount = final.length
    report.buildTables = final.filter(row => names.includes(row.name)).map(row => ({ name: row.name, rows: row.rows, hash: tableDefinitionHash(row.ddl) }))
    report.passed = true
  })
} catch (error) {
  report.error = { code: error.code ?? 'inference_build_current_failed', reason: /^[a-z][a-z0-9_]{2,100}$/.test(error.message ?? '') ? error.message : undefined,
    trace: error.stack?.split('\n').filter(line => line.trim().startsWith('at ')).slice(0, 4) }
  process.exitCode = 1
} finally {
  if (connection) connection.destroy()
  report.observedAt = new Date().toISOString()
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.sync(); await output.close()
  console.log(JSON.stringify({ passed: report.passed, mode, ddlAttempted: report.ddlAttempted,
    beforeStates: report.beforeStates, afterStates: report.afterStates, error: report.error }))
}
