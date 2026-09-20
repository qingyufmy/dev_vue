import assert from 'node:assert/strict'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'
import { loadRiskStructureMigration } from './lib/inplace-risk-structure.mjs'
import { mysqlRiskStructureStore } from './lib/mysql-risk-structure-store.mjs'
import { coordinateRiskStructure } from './lib/risk-structure-coordinator.mjs'
import { withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
const [mode, expectedProofHash, destination] = process.argv.slice(2)
assert.ok(process.argv.length === 5 && mode === '--apply' && /^[a-f0-9]{64}$/.test(expectedProofHash ?? '') && isAbsolute(destination ?? ''))
const root = new URL('../', import.meta.url), base = 'D:/dev_codex/.backup-risk-20260909-01/application-v1/'
const doc = name => fileURLToPath(new URL('docs/architecture/' + name + '.json', root))
const output = await open(destination, 'wx', 0o600)
let connection, ddlAttempted = 0, ddlAcknowledged = 0, journalAttempts = 0
try {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credential = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.ok(credential.host === '127.0.0.1' && credential.port === 13316 && credential.user === 'root')
  connection = await mysql.createConnection({ ...credential, database: 'dev_vue', timezone: 'Z', dateStrings: true,
    jsonStrings: true, supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false, connectTimeout: 5000 })
  await connection.query("SET SESSION time_zone='+00:00'")
  const plan = await loadRiskStructureMigration(root)
  const result = await withInplaceUpgradeLock(connection, 'dev_vue', async () => {
    const store = await mysqlRiskStructureStore(connection, plan, root, {
      proofPath: base + 'risk-structure-proof.json', restorePath: base + 'risk-structure-restore.json',
      referencePath: doc('risk-structure-reference-application-v3-20260909'),
      priorProofPath: doc('current-context-changes-proof-20260908'),
      priorPaths: { proof: doc('current-legacy-candle-promotion-proof-20260908'),
        build: doc('current-legacy-candle-build-proof-20260908'), projection: doc('current-account-projection-proof-20260908'),
        observer: doc('current-observer-context-proof-20260908'), terminal: doc('current-terminal-route-proof-20260908'),
        account: doc('current-account-root-proof-20260908') },
    })
    assert.equal((await store.proof()).proofHash, expectedProofHash, 'risk_structure_expected_proof_mismatch')
    const tracked = { ...store,
      async begin(step) { journalAttempts++; return store.begin(step) },
      async execute(step) { ddlAttempted++; await store.execute(step); ddlAcknowledged++ },
      async complete(step) { journalAttempts++; return store.complete(step) },
    }
    const state = await coordinateRiskStructure(tracked, plan, { apply: true })
    const replay = await coordinateRiskStructure(tracked, plan, { apply: true })
    assert.deepEqual(replay, { status: 'completed', ddlCount: 0 }, 'risk_structure_replay_mismatch')
    return { ...state, identity: await store.identity(), historyCount: (await store.history()).length,
      proofHash: (await store.proof()).proofHash }
  })
  const report = { kind: 'risk-current-upgrade-application/v1', passed: true, observedAt: new Date().toISOString(),
    ...result, ddlAttempted, ddlAcknowledged, journalAttempts, replayDdlCount: 0, scope: 'Applied only the reviewed 043 risk structures to dev_vue. No seeds, backfill or 044 policy receipts. Data and prior history checked by coordinator.' }
  await output.writeFile(JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
} catch (error) {
  let clients
  if (error.message === 'risk_structure_store_other_clients' && connection) {
    const [rows] = await connection.query('SELECT ID id,USER user,HOST host,COMMAND command,TIME seconds FROM information_schema.PROCESSLIST WHERE DB=DATABASE() AND ID<>CONNECTION_ID() ORDER BY ID LIMIT 30')
    clients = rows
  }
  const report = { kind: 'risk-current-upgrade-application/v1', passed: false,
    code: /^(risk_structure_|context_changes_|inplace_|account_root_|legacy_candle_)[a-z_]+$/.test(error.message ?? '')
      ? error.message : 'risk_current_inspection_failed',
    trace: typeof error.stack === 'string' ? error.stack.split('\n').filter(line => line.trim().startsWith('at ')).slice(0, 5) : [],
    ddlAttempted, ddlAcknowledged, journalAttempts, outcome: ddlAttempted > ddlAcknowledged ? 'ddl-unknown' : 'stopped', clients }
  await output.writeFile(JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report)); process.exitCode = 1
} finally {
  if (connection) connection.destroy()
  await output.sync(); await output.close()
}
