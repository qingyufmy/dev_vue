import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import mysql from 'mysql2/promise'
import { hash } from './lib/v4-backfill-contract.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { loadInferenceBuildUpgrade } from './lib/inference-build-upgrade.mjs'
import { coordinateInplaceSchema } from './lib/inplace-schema-coordinator.mjs'
import { mysqlColumnStore, verifyInplaceJournal, withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { validateColumnHistory } from './lib/dev-vue-column-upgrade.mjs'
import { readAccountRootSnapshot } from './lib/mysql-account-root-snapshot.mjs'
import { tableDefinitionHash } from './lib/inplace-foundation-upgrade.mjs'

const [mode, destination] = process.argv.slice(2)
assert.ok(['--prepare', '--inject-start-loss', '--inject-ddl-loss', '--inject-complete-loss',
  '--inject-cycle-ddl-loss', '--resume', '--replay'].includes(mode) && isAbsolute(destination ?? '') && process.argv.length === 4)
const root = new URL('../', import.meta.url), json = async path => JSON.parse(await readFile(path, 'utf8'))
const proofBytes = await readFile(new URL('docs/architecture/inference-restored-baseline-20260910.json', root))
const proof = JSON.parse(proofBytes), target = 'dev_vue_m1_source_20260910_02'
assert.ok(proof.passed && proof.target === target && proof.completedSteps === 191 && proof.startedSteps === 0)
const receiptBytes = await readFile(join(proof.archiveDirectory, 'receipt.json'))
assert.equal(sha256(receiptBytes), proof.receiptSha256)
assert.equal(JSON.parse(receiptBytes).status, 'verified')
const loaded = await loadInferenceBuildUpgrade(root), plan = { steps: loaded.steps, transitions: loaded.transitions }
assert.equal(hash(plan), proof.planHash)
const paths = ['scripts/rehearse-inference-build-local.mjs', 'scripts/run-inference-rehearsal-local.py',
  'scripts/verify-inference-restored-baseline-local.mjs', 'scripts/lib/inference-build-upgrade.mjs',
  'scripts/lib/inference-build-schema.mjs', 'scripts/lib/inplace-schema-coordinator.mjs',
  'scripts/lib/mysql-inplace-column-store.mjs', 'scripts/lib/dev-vue-column-upgrade.mjs',
  'scripts/lib/mysql-account-root-snapshot.mjs', 'scripts/lib/inplace-column-evidence.mjs',
  'scripts/lib/inplace-foundation-upgrade.mjs', 'scripts/lib/v4-backfill-contract.mjs', loaded.added[0].source]
const tools = await Promise.all(paths.map(async path => ({ path, sha256: sha256(await readFile(new URL(path, root))) })))
const binding = { planHash: hash(plan), tools, baselineProofSha256: sha256(proofBytes),
  referenceHash: loaded.referenceHash, inventoryHash: loaded.inventoryHash, receiptSha256: proof.receiptSha256 }
const baselinePath = join(proof.archiveDirectory, 'inference-build-baseline-v1.json')
const names = Object.keys(loaded.finalTableHashes), ids = loaded.added.map(step => step.id)
const first = loaded.added[0], last = loaded.added.at(-1)
const output = await open(destination, 'wx', 0o600)
const report = { kind: 'inference-build-restored-rehearsal/v1', passed: false, mode, target, ...binding,
  serverUuid: proof.serverUuid, currentDevVueWrites: 0, ddlAttempted: 0, ddlAcknowledged: 0, executedStepIds: [] }
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
      const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,@@session.time_zone timezone,@@innodb_force_recovery recovery')
      assert.equal(identity.db, target); assert.equal(identity.uuid, proof.serverUuid)
      assert.equal(identity.timezone, '+00:00'); assert.equal(Number(identity.recovery), 0)
      const [[lock]] = await connection.execute('SELECT IS_USED_LOCK(?) owner,CONNECTION_ID() currentId', [`aurum:inplace:${target}`])
      assert.equal(String(lock.owner), String(lock.currentId))
      const [[clients]] = await connection.query('SELECT COUNT(*) n FROM information_schema.PROCESSLIST WHERE DB=DATABASE() AND ID<>CONNECTION_ID()')
      assert.equal(Number(clients.n), 0)
    }
    const tableHash = async name => {
      assert.ok(names.includes(name))
      const [columns] = await connection.execute('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [name])
      if (!columns.length) return null
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
      assert.equal(hash(current), proof.observations.find(row => row.database === target).snapshotHash)
      assert.equal(current.length, 258)
      for (const name of names) assert.equal(await tableHash(name), null)
      baseline = { kind: 'inference-build-baseline/v1', target, ...binding, history, snapshot: current }
      const file = await open(baselinePath, 'wx', 0o600)
      try { await file.writeFile(JSON.stringify(baseline, null, 2) + '\n'); await file.sync() } finally { await file.close() }
    } else baseline = await json(baselinePath)
    assert.equal(baseline.kind, 'inference-build-baseline/v1'); assert.equal(baseline.target, target)
    for (const [key, value] of Object.entries(binding)) assert.deepEqual(baseline[key], value)
    const protectedTables = rows => rows.filter(row => row.name !== 'database_upgrade_steps_v4' && !names.includes(row.name))
    const verify = async () => {
      await guard(); assert.ok(await verifyInplaceJournal(connection))
      const history = await journal.history(); validateColumnHistory(history, loaded.steps)
      assert.deepEqual(history.filter(row => !ids.includes(row.id)), baseline.history)
      const current = await snapshot()
      assert.equal(hash(protectedTables(current)), hash(protectedTables(baseline.snapshot)), 'protected_tables_changed')
      assert.equal(current.find(row => row.name === 'database_upgrade_steps_v4').ddl,
        baseline.snapshot.find(row => row.name === 'database_upgrade_steps_v4').ddl)
      for (const row of current.filter(row => names.includes(row.name))) assert.equal(Number(row.rows), 0)
      for (const required of loaded.parentRequirements) {
        const [columns] = await connection.execute('SELECT COLUMN_TYPE type,COLLATION_NAME collation,IS_NULLABLE nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?', [required.table, required.column])
        assert.deepEqual(columns, [{ type: required.type, collation: required.collation, nullable: required.nullable }])
      }
      return current
    }
    await verify()
    const store = { history: () => journal.history(), tableHash,
      async begin(step) {
        await guard(); assert.ok(loaded.added.some(s => s.id === step.id && s.checksum === step.checksum))
        await journal.begin(step)
        if (mode === '--inject-start-loss' && step.id === first.id) throw Error('injected_ack_loss')
      },
      async execute(sql) {
        await guard(); const step = loaded.added.find(s => s.sql === sql); assert.ok(step)
        report.ddlAttempted++; report.executedStepIds.push(step.id)
        await connection.query(sql); report.ddlAcknowledged++
        if ((mode === '--inject-ddl-loss' && step.id === first.id)
          || (mode === '--inject-cycle-ddl-loss' && step.id === last.id)) throw Error('injected_ack_loss')
      },
      async complete(step) {
        await guard(); assert.ok(loaded.added.some(s => s.id === step.id && s.checksum === step.checksum))
        await journal.complete(step)
        if (mode === '--inject-complete-loss' && step.id === first.id) throw Error('injected_ack_loss')
      } }
    const inspect = async () => (await coordinateInplaceSchema(store, plan)).steps.map(step => step.status)
    report.beforeStates = await inspect()
    if (mode === '--prepare' || mode === '--inject-start-loss') {
      assert.ok(report.beforeStates.every(state => state === 'pending'))
      assert.equal((await journal.history()).length, 191)
    }
    if (mode === '--inject-ddl-loss') assert.ok(report.beforeStates[0] === 'pending'
      && (await journal.history()).find(row => row.id === first.id)?.status === 'started')
    if (mode === '--inject-complete-loss') assert.equal(report.beforeStates[0], 'reconcile')
    if (mode === '--inject-cycle-ddl-loss') assert.ok(report.beforeStates[0] === 'completed'
      && report.beforeStates.slice(1).every(state => state === 'pending'))
    if (mode === '--resume') assert.ok(report.beforeStates.slice(0, -1).every(state => state === 'completed')
      && report.beforeStates.at(-1) === 'reconcile')
    if (mode === '--replay') assert.ok(report.beforeStates.every(state => state === 'completed'))
    if (mode.startsWith('--inject-')) {
      try { await coordinateInplaceSchema(store, plan, { apply: true }); assert.fail('injection_not_reached') }
      catch (error) { if (error.message !== 'injected_ack_loss') throw error; report.injectedError = error.message }
    } else report.result = await coordinateInplaceSchema(store, plan, { apply: ['--resume', '--replay'].includes(mode) })
    report.afterStates = await inspect()
    if (mode === '--inject-start-loss') assert.ok(report.afterStates.every(state => state === 'pending'))
    if (mode === '--inject-ddl-loss') assert.equal(report.afterStates[0], 'reconcile')
    if (mode === '--inject-complete-loss') assert.equal(report.afterStates[0], 'completed')
    if (mode === '--inject-cycle-ddl-loss') assert.ok(report.afterStates.slice(0, -1).every(state => state === 'completed')
      && report.afterStates.at(-1) === 'reconcile')
    if (mode === '--resume' || mode === '--replay') assert.ok(report.afterStates.every(state => state === 'completed'))
    const expectedDdl = { '--prepare': 0, '--inject-start-loss': 0, '--inject-ddl-loss': 1,
      '--inject-complete-loss': 0, '--inject-cycle-ddl-loss': 12, '--resume': 0, '--replay': 0 }
    assert.equal(report.ddlAttempted, expectedDdl[mode]); assert.equal(report.ddlAcknowledged, expectedDdl[mode])
    const final = await verify()
    report.history = await journal.history(); report.protectedSnapshotHash = hash(protectedTables(final))
    report.protectedTableCount = protectedTables(final).length; report.totalTableCount = final.length
    report.buildTables = final.filter(row => names.includes(row.name)).map(row => ({ name: row.name, rows: row.rows, hash: tableDefinitionHash(row.ddl) }))
    report.passed = true
  })
} catch (error) {
  report.error = { code: error.code ?? 'inference_build_rehearsal_failed', reason: /^[a-z][a-z0-9_]{2,100}$/.test(error.message ?? '') ? error.message : undefined,
    trace: error.stack?.split('\n').filter(line => line.trim().startsWith('at ')).slice(0, 4) }
  process.exitCode = 1
} finally {
  if (connection) connection.destroy()
  report.observedAt = new Date().toISOString()
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.sync(); await output.close()
  console.log(JSON.stringify({ passed: report.passed, mode, ddlAttempted: report.ddlAttempted,
    beforeStates: report.beforeStates, afterStates: report.afterStates, error: report.error }))
}
