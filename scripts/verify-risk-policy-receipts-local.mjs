import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { loadRiskStructureMigration } from './lib/inplace-risk-structure.mjs'
import { MysqlRiskRepository } from '../server/dist-v4/modules/risk/infrastructure/mysql-risk-repository.js'
import { RiskService } from '../server/dist-v4/modules/risk/application/risk-service.js'

const [mode, destination] = process.argv.slice(2)
assert.ok(mode === '--temporary-reference-only' && process.argv.length === 4 && isAbsolute(destination ?? ''))
const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
const credential = JSON.parse(Buffer.concat(chunks).toString('utf8'))
assert.ok(credential.host === '127.0.0.1' && credential.port === 13316 && credential.user === 'root')
const database = 'dev_vue_policy_reference_' + randomUUID().replaceAll('-', '')
assert.match(database, /^dev_vue_policy_reference_[0-9a-f]{32}$/)
const output = await open(destination, 'wx', 0o600), checks = []
const driverErrors = []
let connection, pool, created = false
const sha256 = value => createHash('sha256').update(value).digest('hex')
try {
  const root = new URL('../', import.meta.url)
  const sql = await readFile(new URL('server/db/migrations/inplace/044_risk_policy_write_receipts.sql', root), 'utf8')
  connection = await mysql.createConnection({ ...credential, timezone: 'Z', multipleStatements: false })
  const [[server]] = await connection.query('SELECT @@server_uuid uuid,@@version version')
  assert.equal(server.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  await connection.query(`CREATE DATABASE \`${database}\``); created = true
  await connection.query(`USE \`${database}\``)
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('CREATE TABLE users (id INT NOT NULL PRIMARY KEY) ENGINE=InnoDB')
  await connection.query('CREATE TABLE trading_accounts (id BIGINT UNSIGNED NOT NULL PRIMARY KEY) ENGINE=InnoDB')
  await connection.query(`CREATE TABLE trading_account_ownerships (user_id INT NOT NULL,trading_account_id BIGINT UNSIGNED NOT NULL,role VARCHAR(16) NOT NULL,revoked_at_utc DATETIME(3) NULL, PRIMARY KEY(user_id,trading_account_id)) ENGINE=InnoDB`)
  await connection.query('CREATE TABLE global_risk_controls (id INT PRIMARY KEY,kill_switch TINYINT NOT NULL,revision BIGINT NOT NULL) ENGINE=InnoDB')
  await connection.query(`CREATE TABLE outbox_events (event_id CHAR(36) PRIMARY KEY,aggregate_type VARCHAR(64),aggregate_id VARCHAR(64),event_type VARCHAR(128),payload_json JSON,status VARCHAR(16),attempts INT,available_at_utc DATETIME(3),created_at_utc DATETIME(3)) ENGINE=InnoDB`)
  const plan = await loadRiskStructureMigration(root)
  for (const step of plan.additions) await connection.query(step.sql)
  await connection.query(sql)
  const [[definition]] = await connection.query('SHOW CREATE TABLE risk_policy_write_receipts')
  await connection.query('INSERT INTO users VALUES (42),(43)')
  await connection.query('INSERT INTO trading_accounts VALUES (7),(8)')
  await connection.query("INSERT INTO trading_account_ownerships VALUES (42,7,'owner',NULL),(43,8,'owner',NULL)")
  await connection.query('INSERT INTO global_risk_controls VALUES (1,0,1)')
  await connection.query("INSERT INTO risk_policy_sets_v4 (id,scope,name,status,revision,created_at_utc,updated_at_utc) VALUES (1,'platform','Reference','active',1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))")
  await connection.query("INSERT INTO risk_policy_versions_v4 (id,policy_set_id,version_number,policy_json,policy_sha256,change_reason,created_at_utc) VALUES (1,1,1,'{}',REPEAT('a',64),'Reference',UTC_TIMESTAMP(3))")
  await connection.query('UPDATE risk_policy_sets_v4 SET active_version_id=1 WHERE id=1')
  pool = mysql.createPool({ ...credential, database, timezone: 'Z', connectionLimit: 4, multipleStatements: false })
  const acquire = pool.getConnection.bind(pool)
  pool.getConnection = async () => {
    const raw = await acquire(), execute = raw.execute.bind(raw)
    raw.execute = async (...args) => {
      try { return await execute(...args) }
      catch (error) { driverErrors.push({ code: error.code, operation: String(args[0]).split(/\s+/).slice(0, 3).join(' ') }); throw error }
    }
    return raw
  }
  const make = source => new MysqlRiskRepository(source, () => { throw Error('unused decision writer') })
  const repository = make(pool)
  const input = { userId: 42, actorUserId: 42, accountId: '7', expectedRevision: 0,
    idempotencyKey: 'original-policy-key', patch: { maxRiskPerTradePercent: 0.5, tradeSendEnabled: true }, reason: 'Reference save', changedAt: '2026-09-09T00:00:00.123Z' }
  const [first, duplicate] = await Promise.all([repository.replaceAccountPolicy(input), repository.replaceAccountPolicy(input)])
  assert.deepEqual(first, duplicate); assert.equal(first.policySetRevision, 1)
  checks.push('concurrent-same-request-one-result')
  const counts = async () => {
    const result = {}
    for (const table of ['risk_policy_versions_v4', 'risk_policy_change_items_v4', 'risk_policy_write_receipts', 'outbox_events']) {
      const [[row]] = await connection.query(`SELECT COUNT(*) n FROM \`${table}\``); result[table] = Number(row.n)
    }
    return result
  }
  assert.deepEqual(await counts(), { risk_policy_versions_v4: 2, risk_policy_change_items_v4: 2, risk_policy_write_receipts: 1, outbox_events: 1 })
  checks.push('single-version-audit-outbox-receipt')
  await assert.rejects(repository.replaceAccountPolicy({ ...input, reason: 'Changed reason' }), error => error.code === 'risk_policy_idempotency_conflict')
  checks.push('changed-body-conflicts')
  const wrappedPool = failure => ({ getConnection: async () => {
    const raw = await pool.getConnection()
    return new Proxy(raw, { get(target, key) {
      if (key === 'commit' && failure === 'commit') return async () => { await target.commit(); throw Error('lost acknowledgement') }
      if (key === 'execute' && failure === 'receipt') return async (statement, params) => {
        if (statement.startsWith('INSERT INTO risk_policy_write_receipts')) throw Error('injected receipt failure')
        return target.execute(statement, params)
      }
      const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value
    } })
  } })
  const next = { ...input, expectedRevision: 1, idempotencyKey: 'second-policy-key', patch: { maxRiskPerTradePercent: 0.4 } }
  await assert.rejects(make(wrappedPool('commit')).replaceAccountPolicy(next), error => error.code === 'risk_commit_unknown')
  const receipt = await repository.getPolicyReceipt(42, '7', next.idempotencyKey)
  assert.equal(receipt.policy.policySetRevision, 2)
  const beforeReplay = await counts()
  assert.deepEqual(await repository.replaceAccountPolicy(next), receipt.policy)
  assert.deepEqual(await counts(), beforeReplay)
  checks.push('lost-commit-ack-recovered-without-new-writes')
  await assert.rejects(make(wrappedPool('receipt')).replaceAccountPolicy({ ...next, expectedRevision: 2, idempotencyKey: 'third-policy-key' }), error => error.code === 'risk_storage_unavailable')
  assert.deepEqual(await counts(), beforeReplay)
  assert.equal((await repository.getEffectivePolicy(42, '7')).policySetRevision, 2)
  checks.push('receipt-failure-rolls-back-policy-audit-outbox')
  await assert.rejects(connection.query("INSERT INTO risk_policy_write_receipts SELECT * FROM risk_policy_write_receipts LIMIT 1"), error => error.code === 'ER_DUP_ENTRY')
  checks.push('database-enforces-request-uniqueness')
  const summary = { userId: 42, accountId: '7', businessDate: '2026-09-09', equity: '10000', freeMargin: '9000',
    marginLevelPercent: null, dailyLossPercent: 3.2, drawdownPercent: 1, openPositions: 0, pendingOrders: 0,
    totalVolume: '0', dailyOpenCount: 0, consecutiveLosses: 0, terminalTimezoneOffsetMinutes: 180,
    clockStatus: 'calibrated', lastSuccessfulOpenAt: '2026-09-08T23:58:00.456Z', cooldownUntil: null,
    dataComplete: true, incompleteReasons: [], observedAt: '2026-09-09T00:00:00.123Z', revision: 1 }
  await repository.saveAccountSummary({ summary, expectedRevision: null })
  assert.deepEqual(await repository.getAccountSummary(42, '7'), summary)
  const service = new RiskService(repository)
  const release = await service.createManualRelease({ userId: 42, accountId: '7', expectedSummaryRevision: 1,
    idempotencyKey: 'manual-release-reference', acknowledgeRisk: true, reason: 'Reference release' }, new Date(summary.observedAt))
  const savedRelease = await repository.getManualReleaseByIdempotency(42, '7', 'manual-release-reference')
  assert.equal(savedRelease.release.createdAt, release.createdAt)
  assert.equal(savedRelease.release.expiresAt, release.expiresAt)
  checks.push('summary-and-manual-release-utc-roundtrip')
  const observedAt = '2026-09-09T00:00:01.789Z'
  await repository.saveAccountSummary({ summary: { ...summary, dailyLossPercent: 4.5, observedAt, revision: 2 }, expectedRevision: 1 })
  const invalidated = await repository.getManualReleaseByIdempotency(42, '7', 'manual-release-reference')
  assert.equal(invalidated.release.status, 'superseded')
  assert.equal(invalidated.release.invalidatedAt, observedAt)
  checks.push('deteriorated-summary-invalidates-release-with-utc-time')
  assert.equal(await repository.getPolicyReceipt(43, '8', input.idempotencyKey), null)
  await connection.query("UPDATE trading_account_ownerships SET revoked_at_utc=UTC_TIMESTAMP(3) WHERE user_id=42")
  await assert.rejects(repository.getPolicyReceipt(42, '7', input.idempotencyKey), error => error.code === 'risk_account_forbidden')
  checks.push('receipt-read-rechecks-owner-and-scope')
  const [[stamp]] = await connection.query('SELECT created_at_utc FROM risk_policy_write_receipts ORDER BY created_at_utc LIMIT 1')
  assert.equal(stamp.created_at_utc.toISOString(), input.changedAt)
  checks.push('utc-milliseconds-preserved')
  await pool.end(); pool = null
  await connection.query(`DROP DATABASE \`${database}\``); created = false
  const report = { kind: 'risk-policy-receipt-reference/v1', passed: true, observedAt: new Date().toISOString(),
    serverUuid: server.uuid, serverVersion: server.version, migrationSha256: sha256(sql), canonicalDdl: definition['Create Table'],
    checks, referenceDatabaseRemoved: true, existingDatabaseWrites: 0,
    scope: 'Actual MySQL and compiled risk repository, with typed parent/outbox stubs in an isolated reference database. No current dev_vue upgrade or browser acceptance.' }
  await output.writeFile(JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ passed: true, checks: checks.length, referenceDatabaseRemoved: true }))
} catch (error) {
  const report = { passed: false, checks, driverErrors, code: 'risk_policy_receipt_reference_failed',
    failureCode: /^(risk_|idempotency_)[a-z_]+$/.test(error?.code ?? '') ? error.code : undefined,
    trace: error.stack?.split('\n').filter(line => line.trim().startsWith('at ')).slice(0, 4),
    driverCode: /^ER_[A-Z0-9_]+$/.test(error?.code ?? '') ? error.code : undefined }
  await output.writeFile(JSON.stringify(report) + '\n'); console.log(JSON.stringify(report)); process.exitCode = 1
} finally {
  if (pool) await pool.end()
  if (created) await connection.query(`DROP DATABASE \`${database}\``)
  if (connection) await connection.end()
  await output.sync(); await output.close()
}
