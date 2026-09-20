import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { MysqlBackfillRepository } from './lib/v4-backfill-mysql-repository.mjs'
import { backfillRiskControl } from './lib/risk-control-backfill.mjs'
import { riskControlTargetGuard } from './lib/risk-control-target-guard.mjs'
import { hash } from './lib/v4-backfill-contract.mjs'

const [mode, destination] = process.argv.slice(2)
assert.ok(['--inspect-current-control', '--apply-current-control'].includes(mode) && process.argv.length === 4 && isAbsolute(destination ?? ''))
const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
const credential = JSON.parse(Buffer.concat(chunks).toString('utf8'))
assert.ok(credential.host === '127.0.0.1' && credential.port === 13316 && credential.user === 'root')
const root = new URL('../', import.meta.url)
const json = async file => JSON.parse(await readFile(file, 'utf8'))
const reportPath = name => new URL(`docs/architecture/${name}-20260909.json`, root)
const output = await open(destination, 'wx', 0o600)
let pool
try {
  const reference = await json(reportPath('risk-control-backfill-reference-v2'))
  assert.equal(reference.passed, true); assert.equal(reference.temporaryDatabaseRemoved, true)
  assert.equal(reference.currentDatabaseWrites, 0)
  assert.equal(reference.checks.length, 7)
  for (const item of reference.artifacts) assert.equal(createHash('sha256').update(await readFile(new URL(item.file, root))).digest('hex'), item.sha256)
  const upgrade = await json(reportPath('risk-receipt-current-upgrade'))
  const baseline = await json('D:/dev_codex/.backup-risk-20260909-01/risk-receipt-current-baseline.json')
  const preview = await json(reportPath('risk-legacy-control-preview'))
  assert.equal(preview.mappingValid, true); assert.equal(preview.sourceCount, 1); assert.equal(preview.targetCount, '0')
  const verify = riskControlTargetGuard(upgrade, baseline)
  const spec = { runId: '42b7d2b9-862f-48be-ada9-dc4e5b88a217', sourceSha256: preview.sourceSha256,
    bindings: { kind: 'risk-control-backfill/v1', database: 'dev_vue', serverUuid: upgrade.identity.serverUuid,
      referenceHash: hash(reference), historyHash: hash(upgrade.history), baselineHash: hash(baseline) } }
  pool = mysql.createPool({ ...credential, database: 'dev_vue', timezone: 'Z', connectionLimit: 1 })
  // Release advisory lock before the pool connection is returned, including rejected transactions.
  const locked = { async transaction(work) {
    const connection = await pool.getConnection()
    try {
      const [[lock]] = await connection.execute('SELECT GET_LOCK(?,0) acquired', ['aurum:inplace:dev_vue'])
      assert.equal(Number(lock.acquired), 1)
      const borrowed = new MysqlBackfillRepository({ getConnection: async () => new Proxy(connection, {
        get(target, key) { if (key === 'release') return () => {}; const value = target[key]; return typeof value === 'function' ? value.bind(target) : value },
      }) })
      return await borrowed.transaction(work)
    } finally {
      try { await connection.execute('SELECT RELEASE_LOCK(?)', ['aurum:inplace:dev_vue']); connection.release() }
      catch { connection.destroy() }
    }
  } }
  const inspect = mode === '--inspect-current-control'
  const result = inspect ? await locked.transaction(async tx => { await verify(tx.connection, spec.bindings); return { status: 'verified', writes: 0 } })
    : await backfillRiskControl(locked, spec, verify)
  const replay = inspect ? null : await backfillRiskControl(locked, spec, verify)
  if (!inspect) assert.equal(replay.replay, true)
  const report = { kind: 'risk-control-current-backfill/v1', passed: true, identity: upgrade.identity,
    mode, runId: spec.runId, sourceSha256: spec.sourceSha256, result, replay, historyCount: 175, referenceHash: hash(reference), ddlCount: 0 }
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report))
} catch (error) {
  const report = { passed: false, code: error.code ?? 'risk_control_current_failed' }
  await output.writeFile(JSON.stringify(report) + '\n'); console.log(JSON.stringify(report)); process.exitCode = 1
} finally { if (pool) await pool.end(); await output.sync(); await output.close() }
