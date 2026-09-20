import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { loadRiskStructureMigration } from './lib/inplace-risk-structure.mjs'
import { coordinateRiskStructure, inspectRiskStructure } from './lib/risk-structure-coordinator.mjs'
import { readRiskStructureTable } from './lib/mysql-risk-structure-state.mjs'
import { freezeRiskStructureTools } from './lib/mysql-risk-structure-store.mjs'
import { riskStructureReferenceChecks } from './lib/risk-structure-proof.mjs'
import { riskStructureTables } from './lib/risk-structure-source.mjs'
import { tableDefinitionHash } from './lib/inplace-foundation-upgrade.mjs'
import { mysqlColumnStore, verifyInplaceJournal, withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { readAccountRootSnapshot } from './lib/mysql-account-root-snapshot.mjs'
import { legacyCandlePromotionSnapshot } from './lib/legacy-candle-promotion.mjs'
import { verifyRiskPriorHistory } from './lib/risk-prior-history.mjs'
import { hash } from './lib/v4-backfill-contract.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'

const [mode, destination, referencePath] = process.argv.slice(2)
assert.ok(['--inspect', '--inject-create-loss', '--inject-alter-loss', '--resume'].includes(mode)
  && [4, 5].includes(process.argv.length) && isAbsolute(destination ?? '')
  && (referencePath === undefined || isAbsolute(referencePath)))
const root = new URL('../', import.meta.url), target = 'dev_vue_m1_source_20260909_01'
const uuid = 'ac423207-6ef3-11f1-b302-000c29fda104'
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const doc = name => new URL('docs/architecture/' + name, root)
const output = await open(destination, 'wx', 0o600)
let connection, ddlCount = 0, injected = false
try {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credential = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.ok(credential.host === '127.0.0.1' && credential.port === 13316 && credential.user === 'root')
  const plan = await loadRiskStructureMigration(root)
  const baseline = await json(doc('risk-restored-baseline-166-20260909.json'))
  const receipt = await readFile('D:/dev_codex/.backup-risk-20260909-01/receipt.json')
  assert.equal(sha256(receipt), baseline.backupReceiptHash)
  assert.equal(baseline.passed, true); assert.equal(baseline.registrySteps, 166)
  assert.deepEqual(baseline.restoredIdentity, { database: target, serverUuid: uuid })
  const reference = await json(referencePath ?? doc('risk-structure-reference-rehearsal-20260909.json'))
  assert.deepEqual(reference.identity, baseline.sourceIdentity)
  assert.equal(reference.referenceDatabaseRemoved, true); assert.equal(reference.existingDatabaseWrites, 0)
  assert.deepEqual(reference.checks, riskStructureReferenceChecks)
  const definitions = reference.definitions
  assert.equal(definitions.length, plan.additions.length)
  for (const [index, step] of plan.additions.entries()) {
    assert.equal(definitions[index].stepId, step.id); assert.equal(definitions[index].stepChecksum, step.checksum)
    assert.equal(definitions[index].afterHash, tableDefinitionHash(definitions[index].canonicalDdl))
  }
  connection = await mysql.createConnection({ ...credential, database: target, timezone: 'Z', dateStrings: true,
    jsonStrings: true, supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false, connectTimeout: 5000 })
  await connection.query("SET SESSION time_zone='+00:00'")
  const guard = async () => {
    const [[row]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,@@session.time_zone timezone,CONNECTION_ID() id')
    assert.equal(row.db, target); assert.equal(row.uuid, uuid); assert.equal(row.timezone, '+00:00')
    const [[lock]] = await connection.execute('SELECT IS_USED_LOCK(?) owner', ['aurum:inplace:' + target])
    assert.equal(String(lock.owner), String(row.id))
    const [[clients]] = await connection.execute('SELECT COUNT(*) n FROM information_schema.PROCESSLIST WHERE DB=? AND ID<>CONNECTION_ID()', [target])
    assert.equal(Number(clients.n), 0)
  }
  const result = await withInplaceUpgradeLock(connection, target, async () => {
    const journal = mysqlColumnStore(connection, true)
    const verifyPlan = async candidate => {
      await guard()
      assert.equal(hash(candidate.steps), hash((await loadRiskStructureMigration(root)).steps))
      assert.equal(reference.registryHash, hash(plan.steps.map(({ id, checksum }) => ({ id, checksum }))))
      assert.deepEqual(reference.tools, await freezeRiskStructureTools(root))
      await verifyInplaceJournal(connection)
      return definitions
    }
    const index = mode === '--inject-create-loss' ? 0 : mode === '--inject-alter-loss' ? 2 : null
    if (index !== null) assert.equal((await journal.history()).some(row => row.id === plan.additions[index].id), false)
    const assertStep = step => assert.ok(plan.additions.some(row => hash(row) === hash(step)))
    const store = {
      verifyPlan,
      async history() { await guard(); return journal.history() },
      async tableState(table) { await guard(); return readRiskStructureTable(connection, table) },
      async snapshot() { await guard(); return legacyCandlePromotionSnapshot((await readAccountRootSnapshot(connection)).tables) },
      async verifyProtected(snapshot) { assert.equal(hash(snapshot), baseline.restoredSnapshotHash) },
      async verifyPrior(history, snapshot) {
        assert.equal(hash(history), baseline.restoredHistoryHash)
        assert.equal(hash(snapshot), baseline.restoredSnapshotHash)
        await verifyRiskPriorHistory(connection, plan.prior, history)
        return { status: 'completed' }
      },
      async begin(step) { assertStep(step); await verifyPlan(plan); await journal.begin(step) },
      async execute(step) {
        assertStep(step); await verifyPlan(plan)
        await connection.query(step.sql); ddlCount++
        console.log(JSON.stringify({ stage: 'ddl-applied', step: step.id }))
        if (index !== null && step.id === plan.additions[index].id) { injected = true; throw Error('injected-response-loss') }
      },
      async complete(step) { assertStep(step); await verifyPlan(plan); await journal.complete(step) },
    }
    console.log(JSON.stringify({ stage: 'inspect-restored-structure', mode }))
    let result
    if (index !== null) {
      await assert.rejects(coordinateRiskStructure(store, plan, { apply: true }), /risk_structure_ddl_unknown/)
      assert.equal(injected, true)
      const state = await inspectRiskStructure(store, plan)
      assert.equal(state.status, 'reconcile'); assert.equal(state.step.id, plan.additions[index].id)
      result = { status: 'ddl-unknown-injected', next: state.step.id }
    } else result = await coordinateRiskStructure(store, plan, { apply: mode === '--resume' })
    const snapshot = await store.snapshot()
    const protectedSnapshot = snapshot.filter(row => !riskStructureTables.includes(row.name))
    assert.equal(hash(protectedSnapshot), baseline.restoredSnapshotHash)
    return { result, history: await journal.history(), tableCount: snapshot.length, protectedSnapshotHash: hash(protectedSnapshot) }
  })
  await output.writeFile(JSON.stringify({ kind: 'risk-structure-rehearsal/v1', passed: true, observedAt: new Date().toISOString(),
    identity: { database: target, serverUuid: uuid }, mode, ...result, ddlCount, baselineHash: hash(baseline),
    referenceHash: hash(reference), tools: reference.tools, sourceWrites: 0,
    scope: 'Verified restored copy only. Full 166-step source validation is bound through baseline/backup parity; original tables and history rechecked. Injected lost acknowledgement, not an actual network outage. Current dev_vue not upgraded.' }, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, result: result.result, ddlCount, tableCount: result.tableCount }))
} catch (error) {
  await output.writeFile(JSON.stringify({ passed: false, mode, ddlCount, injected, code: 'risk_rehearsal_failed',
    reason: /^(risk_structure_|inplace_)[a-z_]+$/.test(error.message ?? '') ? error.message : undefined }) + '\n')
  console.log(JSON.stringify({ passed: false, code: 'risk_rehearsal_failed', ddlCount, injected }))
  process.exitCode = 1
} finally {
  if (connection) connection.destroy()
  await output.sync(); await output.close()
}
