import { verifyHistoryTraversalReference } from './lib/history-traversal-reference.mjs'
import { verifyOpenPositionLifecycleReference } from './lib/open-position-lifecycle-reference.mjs'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import mysql from 'mysql2/promise'
import { hash } from './lib/v4-backfill-contract.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { MysqlTradeHistoryCollectorRepository } from '../server/dist-v4/modules/trade-history/infrastructure/mysql-trade-history-collector-repository.js'
import { HistoryCommitUnknown } from '../server/dist-v4/modules/trade-history/application/history-commit-unknown.js'
import { verifyHistoryDealProvenanceReference, verifyHistoryDealCollectorReference } from './lib/history-deal-provenance-reference.mjs'
import { verifyHistoryTaskReference, verifyHistoryTaskClaimsReference } from './lib/history-task-reference.mjs'
import { verifyHistoryTaskQueueReference } from './lib/history-task-queue-reference.mjs'
import { verifyHistoryTaskSchedulerReference } from './lib/history-task-scheduler-reference.mjs'
import { verifyHistoryTaskRecoveryReference } from './lib/history-task-recovery-reference.mjs'
import { verifyHistoryTaskCollectorReference } from './lib/history-task-collector-reference.mjs'
import { verifyHistoryTaskRegistrationReference } from './lib/history-task-registration-reference.mjs'

const [mode, destination] = process.argv.slice(2)
assert.ok(mode === '--reference-only' && process.argv.length === 4 && isAbsolute(destination ?? ''))
const root = new URL('../', import.meta.url), json = async p => JSON.parse(await readFile(p, 'utf8'))
const baseline = await json(new URL('docs/architecture/core-refactor-restored-baseline-20260910.json', root))
const snapshots = await json(join(baseline.archiveDirectory, 'source-snapshot.json'))
assert.equal(hash(snapshots), baseline.sourceSnapshotHash)
const database = 'dev_vue_history_ref_' + randomUUID().replaceAll('-', '')
assert.match(database, /^dev_vue_history_ref_[a-f0-9]{32}$/)
const file = await open(destination, 'wx', 0o600)
const report = { kind: 'history-completion-transaction-reference/v1', passed: false, existingDatabaseWrites: 0,
  database, referenceDatabaseRemoved: false, authorization: 'injected-exact-route-guard', parentSchema: 'minimal-users-and-trading-accounts', checks: [] }
let admin, created = false
const connections = new Set()
try {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credential = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.ok(credential.host === '127.0.0.1' && credential.port === 13316 && credential.user === 'root')
  admin = await mysql.createConnection({ ...credential, timezone: 'Z', multipleStatements: false })
  const [[identity]] = await admin.query('SELECT @@server_uuid uuid,@@innodb_force_recovery recovery')
  assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104'); assert.equal(Number(identity.recovery), 0)
  report.serverUuid = identity.uuid
  const files = ['scripts/lib/position-protection-outcome-reference.mjs','scripts/lib/position-protection-result-transaction-reference.mjs','scripts/lib/position-protection-binding-reference.mjs','scripts/lib/bound-child-persistence-reference.mjs','scripts/lib/collected-history-position-chain-reference.mjs','scripts/lib/collected-history-parent-proof-reference.mjs','server/src/modules/execution/domain/partial-close-protection.ts','server/dist-v4/modules/execution/domain/partial-close-protection.js','server/src/modules/execution/application/partial-close-history-proof-reader.ts','scripts/lib/closed-order-history-reference.mjs','server/src/modules/trade-history/domain/closed-order-fills.ts','server/dist-v4/modules/trade-history/domain/closed-order-fills.js','server/src/modules/trade-history/application/closed-order-history-reader.ts','server/dist-v4/modules/trade-history/application/closed-order-history-reader.js','server/src/modules/trade-history/infrastructure/mysql-closed-order-history-reader.ts','server/dist-v4/modules/trade-history/infrastructure/mysql-closed-order-history-reader.js','server/src/bootstrap/partial-close-history-proof.ts','server/dist-v4/bootstrap/partial-close-history-proof.js','server/src/modules/trade-history/application/open-position-history-reader.ts',
    'server/dist-v4/modules/trade-history/application/open-position-history-reader.js',
    'server/src/modules/trade-history/infrastructure/mysql-open-position-history-reader.ts',
    'server/dist-v4/modules/trade-history/infrastructure/mysql-open-position-history-reader.js','server/src/modules/trade-history/infrastructure/mysql-history-window-coverage-reader.ts',
    'server/dist-v4/modules/trade-history/infrastructure/mysql-history-window-coverage-reader.js','server/src/modules/trade-history/infrastructure/mysql-history-task-deal-source-reader.ts',
    'server/dist-v4/modules/trade-history/infrastructure/mysql-history-task-deal-source-reader.js','server/src/modules/trade-history/infrastructure/mysql-history-task-coverage-reader.ts',
    'server/dist-v4/modules/trade-history/infrastructure/mysql-history-task-coverage-reader.js','server/src/modules/bridge/domain/history-query-coverage.ts',
    'server/dist-v4/modules/bridge/domain/history-query-coverage.js',
    'server/src/modules/trade-history/application/history-page-chain.ts',
    'server/dist-v4/modules/trade-history/application/history-page-chain.js','scripts/lib/history-traversal-reference.mjs',
    'server/src/modules/trade-history/infrastructure/mysql-history-traversal-reader.ts',
    'server/dist-v4/modules/trade-history/infrastructure/mysql-history-traversal-reader.js','scripts/lib/open-position-lifecycle-reference.mjs',
    'server/src/modules/trade-history/infrastructure/mysql-open-position-lifecycle-reader.ts',
    'server/dist-v4/modules/trade-history/infrastructure/mysql-open-position-lifecycle-reader.js',
    'server/src/modules/inference/application/reference-position-lifecycle.ts',
    'server/dist-v4/modules/inference/application/reference-position-lifecycle.js',
    'server/src/modules/inference/infrastructure/mysql-strategy-reference-source-reader.ts',
    'server/dist-v4/modules/inference/infrastructure/mysql-strategy-reference-source-reader.js','scripts/verify-history-completion-reference-local.mjs', 'scripts/run-history-completion-reference-local.py',
    'server/src/modules/trade-history/infrastructure/mysql-trade-history-collector-repository.ts',
    'server/src/modules/trade-history/infrastructure/history-transaction.ts',
    'server/src/modules/trade-history/infrastructure/mysql-history-collection-receipt-writer.ts',
    'server/dist-v4/modules/trade-history/infrastructure/mysql-trade-history-collector-repository.js',
    'server/dist-v4/modules/trade-history/infrastructure/history-transaction.js',
    'server/dist-v4/modules/trade-history/infrastructure/mysql-history-collection-receipt-writer.js',
    'server/dist-v4/modules/trade-history/application/history-collection-receipt.js',
    'server/dist-v4/modules/trade-history/infrastructure/trade-history-ownership-sql.js',
    'server/db/migrations/inplace/051_history_collection_receipts.sql',
    'scripts/lib/history-deal-provenance-reference.mjs',
    'server/src/modules/trade-history/application/history-deal-provenance.ts',
    'server/src/modules/trade-history/infrastructure/mysql-history-deal-provenance-writer.ts',
    'server/dist-v4/modules/trade-history/application/history-deal-provenance.js',
    'server/dist-v4/modules/trade-history/infrastructure/mysql-history-deal-provenance-writer.js',
    'server/db/migrations/inplace/052_terminal_history_deal_provenance.sql',
    'scripts/lib/history-task-reference.mjs', 'server/db/migrations/inplace/053_history_collection_tasks.sql',
    'server/src/modules/trade-history/application/history-collection-task.ts',
    'server/src/modules/trade-history/infrastructure/mysql-history-task-lock.ts',
    'server/dist-v4/modules/trade-history/application/history-collection-task.js',
    'server/dist-v4/modules/trade-history/infrastructure/mysql-history-task-lock.js',
    'server/src/modules/trade-history/application/history-task-completion.ts',
    'server/src/modules/trade-history/infrastructure/mysql-history-task-completion.ts',
    'server/dist-v4/modules/trade-history/application/history-task-completion.js',
    'server/dist-v4/modules/trade-history/infrastructure/mysql-history-task-completion.js',
    'server/src/modules/trade-history/application/history-collection-tasks.ts',
    'server/src/modules/trade-history/infrastructure/mysql-history-collection-tasks.ts',
    'server/dist-v4/modules/trade-history/infrastructure/mysql-history-collection-tasks.js',
    'server/src/modules/trade-history/application/history-page-membership.ts',
    'server/dist-v4/modules/trade-history/application/history-page-membership.js',
    'server/src/modules/inference/application/read-strategy-reference-portfolio.ts',
    'server/dist-v4/modules/inference/application/read-strategy-reference-portfolio.js',
    'server/src/bootstrap/strategy-reference-evidence.ts',
    'server/src/entrypoints/worker-trader.ts',
    'server/src/bootstrap/strategy-reference-position-evidence.ts',
    'server/dist-v4/bootstrap/strategy-reference-position-evidence.js',
    'server/src/modules/inference/application/reference-position-evidence.ts',
    'server/dist-v4/bootstrap/strategy-reference-evidence.js', 'server/dist-v4/modules/bridge/infrastructure/redis-bridge-gateway-lease-store.js',
    'server/dist-v4/modules/execution/infrastructure/mysql-pending-origin-reader.js','server/dist-v4/modules/inference/infrastructure/mysql-trade-decision-origin-reader.js',
    'server/dist-v4/modules/inference/infrastructure/mysql-trade-decision-entry-analysis-reader.js',
    'scripts/lib/reference-gateway-lease-fixture.mjs', 'scripts/lib/reference-observer-sql-fixture.mjs', 'scripts/lib/reference-entry-sql-fixture.mjs', 'scripts/lib/history-task-queued-collection-reference.mjs', 'scripts/lib/history-task-queue-reference.mjs', 'scripts/lib/development-redis.mjs',
    'server/dist-v4/outbox/infrastructure/mysql-outbox-repository.js',
    'server/dist-v4/outbox/infrastructure/bullmq-outbox-task-publisher.js',
    'server/dist-v4/queue/bridge-history-task-processor.js',
    'server/dist-v4/queue/task-queues.js',
    'scripts/lib/history-task-scheduler-reference.mjs',
    'server/src/modules/trade-history/infrastructure/history-schedule-transaction.ts',
    'server/dist-v4/modules/trade-history/infrastructure/history-schedule-transaction.js',
    'server/src/modules/trade-history/infrastructure/mysql-trade-history-schedule-repository.ts',
    'server/dist-v4/modules/trade-history/infrastructure/mysql-trade-history-schedule-repository.js',
    'scripts/lib/history-task-recovery-reference.mjs',
    'server/src/modules/trade-history/infrastructure/mysql-history-task-recovery.ts',
    'server/dist-v4/modules/trade-history/infrastructure/mysql-history-task-recovery.js',
    'scripts/lib/history-task-registration-reference.mjs', 'scripts/lib/history-task-collector-reference.mjs',
    'server/src/modules/trade-history/application/history-task-processor.ts',
    'server/src/modules/trade-history/application/history-task-worker.ts',
    'server/dist-v4/modules/trade-history/application/history-task-worker.js',
    'server/src/modules/trade-history/infrastructure/mysql-history-task-locator.ts',
    'server/dist-v4/modules/trade-history/infrastructure/mysql-history-task-locator.js',
    'server/dist-v4/modules/trade-history/application/history-task-processor.js',
    'server/src/modules/trade-history/composition.ts',
    'server/dist-v4/modules/trade-history/composition.js',
    'server/src/modules/trade-history/infrastructure/mysql-history-task-result.ts',
    'server/dist-v4/modules/trade-history/infrastructure/mysql-history-task-result.js',
    'server/src/modules/trade-history/infrastructure/mysql-history-task-registration.ts',
    'server/dist-v4/modules/trade-history/infrastructure/mysql-history-task-registration.js',
    'server/dist-v4/modules/trading/infrastructure/mysql-account-inventory-summary-reader.js']
  report.tools = await Promise.all(files.map(async path => ({ path, sha256: sha256(await readFile(new URL(path, root))) })))
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`); created = true
  await admin.query(`USE \`${database}\``)
  await admin.query("SET SESSION time_zone='+00:00'")
  await admin.query("CREATE TABLE users (id INT PRIMARY KEY,deletion_status VARCHAR(32) NOT NULL DEFAULT 'active',deleted_at DATETIME(3) NULL) ENGINE=InnoDB")
  await admin.query('CREATE TABLE trading_accounts (id BIGINT UNSIGNED PRIMARY KEY) ENGINE=InnoDB')
  report.definitions = []
  for (const name of ['trading_account_ownership_intervals', 'trade_history_sync_states_v4', 'account_trade_records_v4', 'account_trade_daily_summaries_v4', 'outbox_events']) {
    const ddl = snapshots.find(t => t.name === name).ddl
    await admin.query(ddl)
    report.definitions.push({ table: name, sourceDdlHash: sha256(ddl) })
  }
  await admin.query(await readFile(new URL('server/db/migrations/inplace/051_history_collection_receipts.sql', root), 'utf8'))
  await admin.query('INSERT INTO users (id) VALUES (7)')
  await admin.query('INSERT INTO trading_accounts (id) VALUES (5)')
  const now = new Date('2026-09-10T00:00:00.000Z'), interval = randomUUID()
  await admin.execute(`INSERT INTO trading_account_ownership_intervals
    (id,user_id,trading_account_id,role,started_at_utc,origin_kind,origin_ref,created_at_utc,updated_at_utc)
    VALUES (?,7,5,'owner','2020-01-01','runtime','reference',?,?)`, [interval, now, now])
  await admin.execute(`INSERT INTO account_trade_records_v4
    (id,user_id,trading_account_id,stable_trade_key,platform,primary_ticket,symbol,side,status,source_classification,
    attribution_status,evidence_status,volume_opened,volume_closed,entry_price,gross_profit,commission,net_profit,
    opened_at_utc,closed_at_utc,close_business_date,terminal_timezone_offset_minutes,evidence_sha256,observed_at_utc,created_at_utc,updated_at_utc,ownership_interval_id)
    VALUES (?,7,5,'reference','mt5','91','XAUUSD','buy','closed','unknown','unresolved','complete',1,1,2500,12.25,-2.25,10,
    '2026-09-09 01:00:00','2026-09-09 02:00:00','2026-09-09',180,REPEAT('a',64),?,?,?,?)`, [randomUUID(), now, now, now, interval])
  await admin.execute(`INSERT INTO trade_history_sync_states_v4 (trading_account_id,status,history_revision,updated_at_utc)
    VALUES (5,'syncing',0,?)`, [now])
  const route = { userId: 7, accountId: '5', platform: 'mt5', terminalInstanceId: 'terminal', terminalProfileId: 'profile',
    brokerServer: 'Broker', login: '001', connectionEpoch: 3, connectionId: 'connection', sessionId: 'session', ownershipRevision: '2', timezoneOffsetMinutes: 180 }
  const chains = ['history.orders', 'history.deals'].map(resource => ({ resource, rangeStartUtcMsc: now.getTime()-86400000,
    rangeEndUtcMsc: now.getTime(), source: 'terminal', sourceRevision: 'r1', pageCount: 1, itemCount: 1, pageChainHash: 'a'.repeat(64) }))
  let fault = null, destroyed = 0, acquired = 0
  const pool = {
    async execute(sql, values) {
      const connection = await this.getConnection()
      try { return await connection.execute(sql, values) } finally { connection.release() }
    },
    async getConnection() {
    const connection = await mysql.createConnection({ ...credential, database, timezone: 'Z', multipleStatements: false })
    connections.add(connection); acquired++
    let taskFinished = false
    await connection.query("SET SESSION time_zone='+00:00'")
    return new Proxy(connection, { get(target, property) {
      if (property === 'release') return () => { connections.delete(target); target.destroy() }
      if (property === 'destroy') return () => { destroyed++; connections.delete(target); target.destroy() }
      if (property === 'commit') return async () => {
        await target.commit()
        if (fault === 'commit-ack' || (fault === 'task-completion-ack' && taskFinished)) { fault = null; throw Error('injected_commit_ack_loss') }
      }
      if (property === 'execute') return async (sql, values) => {
        const result = await target.execute(sql, values)
        if (sql.includes("UPDATE history_collection_tasks_v4 SET status='succeeded'")) taskFinished = true
        if (fault === 'deal-provenance-before-commit' && sql.includes('INSERT INTO terminal_history_deal_provenance_v4')) { fault = null; throw Error('injected_deal_provenance_failure') }
        if (fault === 'outbox-before-commit' && sql.includes('INSERT INTO outbox_events')) { fault = null; throw Error('injected_precommit_failure') }
        return result
      }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    } })
  } }
  const repository = new MysqlTradeHistoryCollectorRepository(pool, connection => ({ async assert(candidate) {
    assert.deepEqual(candidate, route)
    const [[r]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,@@session.time_zone tz')
    assert.equal(r.db, database); assert.equal(r.uuid, identity.uuid); assert.equal(r.tz, '+00:00')
  } }))
  const capture = async () => {
    const [[sync]] = await admin.query('SELECT status,CAST(history_revision AS CHAR) revision,fresh_through_utc,last_success_at_utc,last_error_code,updated_at_utc FROM trade_history_sync_states_v4 WHERE trading_account_id=5')
    const [receipts] = await admin.query('SELECT id,evidence_sha256,evidence_json,created_at_utc FROM terminal_history_collection_receipts_v4 ORDER BY id')
    const [summaries] = await admin.query('SELECT user_id,trade_count,gross_profit,commission,net_profit,CAST(history_revision AS CHAR) revision FROM account_trade_daily_summaries_v4 ORDER BY user_id')
    const [outbox] = await admin.query('SELECT event_id,event_type,payload_json,created_at_utc FROM outbox_events ORDER BY id')
    return { sync: { ...sync }, receipts: receipts.map(r=>({...r})), summaries: summaries.map(r=>({...r})), outbox: outbox.map(r=>({...r})) }
  }
  const initial = await capture()
  fault = 'outbox-before-commit'
  await assert.rejects(repository.complete(route, now.getTime(), now, chains), { message: 'injected_precommit_failure' })
  assert.deepEqual(await capture(), initial)
  report.checks.push('receipt-sync-summary-outbox-all-rollback-before-commit')
  fault = 'commit-ack'
  await assert.rejects(repository.complete(route, now.getTime(), now, chains), HistoryCommitUnknown)
  assert.equal(destroyed, 1)
  const committed = await capture()
  assert.equal(committed.sync.status, 'ready'); assert.equal(committed.sync.revision, '1')
  assert.equal(committed.receipts.length, 1); assert.equal(committed.outbox.length, 1)
  assert.deepEqual(committed.summaries, [{ user_id: 7, trade_count: 1, gross_profit: '12.25000000', commission: '-2.25000000', net_profit: '10.00000000', revision: '1' }])
  report.checks.push('real-commit-before-ack-loss-and-exact-nonempty-summary')
  await repository.complete(route, now.getTime(), new Date(now.getTime()+1000), chains)
  assert.deepEqual(await capture(), committed)
  assert.equal(acquired, 3)
  report.checks.push('new-connection-same-evidence-replay-zero-additional-writes')
  const changed = chains.map(c => ({ ...c, sourceRevision: 'different' }))
  await assert.rejects(repository.complete(route, now.getTime(), now, changed), { message: 'trade_history_sync_not_active' })
  assert.deepEqual(await capture(), committed)
  report.checks.push('changed-evidence-cannot-reuse-committed-receipt')
  await admin.query("UPDATE trade_history_sync_states_v4 SET status='syncing' WHERE trading_account_id=5")
  const nextEnd = now.getTime()+2000, next = chains.map(c => ({ ...c, rangeEndUtcMsc: nextEnd, sourceRevision: 'r2' }))
  await Promise.all([repository.complete(route, nextEnd, new Date(nextEnd), next), repository.complete(route, nextEnd, new Date(nextEnd), next)])
  const concurrent = await capture()
  assert.equal(concurrent.sync.revision, '2'); assert.equal(concurrent.receipts.length, 2); assert.equal(concurrent.outbox.length, 2)
  assert.equal(concurrent.summaries[0].revision, '2'); assert.equal(concurrent.summaries[0].net_profit, '10.00000000')
  report.checks.push('concurrent-identical-completion-one-revision-and-one-event')
  report.finalStateHash = hash(JSON.parse(JSON.stringify(concurrent))); report.connectionsAcquired = acquired
  report.dealProvenance = await verifyHistoryDealProvenanceReference(admin, snapshots)
  report.dealCollector = await verifyHistoryDealCollectorReference(admin, repository, route, now, value => { fault = value })
  report.collectionTasks = await verifyHistoryTaskReference(admin, route, now)
  report.taskClaims = await verifyHistoryTaskClaimsReference(admin, pool, route, value => { fault = value })
  report.taskRegistration = await verifyHistoryTaskRegistrationReference(admin, pool, now, value => { fault = value })
  report.taskCollector = await verifyHistoryTaskCollectorReference(admin, pool, route, now, value => { fault = value })
  report.taskRecovery = await verifyHistoryTaskRecoveryReference(admin, pool, route, now, value => { fault = value })
  report.taskScheduler = await verifyHistoryTaskSchedulerReference(admin, pool, snapshots, now, value => { fault = value })
  report.taskQueue = await verifyHistoryTaskQueueReference(admin, pool, route, value => { fault = value }, value => { report.taskQueueDiagnostics = value }, snapshots)
  report.positionLifecycle = await verifyOpenPositionLifecycleReference(admin, pool)
  report.historyTraversal = await verifyHistoryTraversalReference(admin, pool, route)
  report.passed = true
} catch (error) {
  report.error = { code: 'history_completion_reference_failed', databaseCode: /^ER_[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : undefined, reason: /^[a-z][a-z0-9_]{2,100}$/.test(error.message ?? '') ? error.message : undefined,
    trace: error.stack?.split('\n').filter(line=>line.trim().startsWith('at ')).slice(0,4) }
  process.exitCode = 1
} finally {
  for (const connection of connections) connection.destroy()
  if (admin) {
    try {
      if (created) {
        await admin.query(`DROP DATABASE \`${database}\``)
        const [rows] = await admin.execute('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [database])
        assert.equal(rows.length, 0); report.referenceDatabaseRemoved = true
      }
    } catch { report.passed = false; report.cleanupFailed = true; process.exitCode = 1 }
    admin.destroy()
  }
  report.observedAt = new Date().toISOString()
  await file.writeFile(JSON.stringify(report,null,2)+'\n'); await file.sync(); await file.close()
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks, referenceDatabaseRemoved: report.referenceDatabaseRemoved, error: report.error }))
}
