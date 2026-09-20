import Redis from 'ioredis'
import { parse as parseEnv } from 'dotenv'
import { RedisBridgeGatewayLeaseStore } from '../server/dist-v4/modules/bridge/infrastructure/redis-bridge-gateway-lease-store.js'
import { createMysqlPendingOrderOriginReader } from '../server/dist-v4/modules/execution/infrastructure/mysql-pending-order-origin-reader.js'
import { createTransactionRiskDecisionExecutionWriter, createTransactionRiskPolicyReader } from '../server/dist-v4/modules/risk/composition.js'
import { createTransactionTradeDecisionOriginReader, createTransactionTradeDecisionAnalysisReader } from '../server/dist-v4/modules/inference/composition.js'
import { createMysqlInstrumentSnapshotReader, createTransactionPendingReader, createTransactionAccountClock } from '../server/dist-v4/modules/trading/composition.js'
import { createMysqlPendingPreparationReviewer } from '../server/dist-v4/modules/execution/composition.js'
import { MysqlExecutionRepository, MysqlExecutionCommandSource } from '../server/dist-v4/modules/execution/composition.js'
import { ExecutionService, BridgeCommandService } from '../server/dist-v4/modules/execution/index.js'
import { riskPolicyHash } from '../server/dist-v4/modules/risk/index.js'
import { createMysqlPreparedPendingOccupancyReader } from '../server/dist-v4/modules/execution/infrastructure/mysql-prepared-pending-occupancy-reader.js'
import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { MysqlBridgeCommandRepository, createMysqlPendingCommandReviewer } from '../server/dist-v4/modules/execution/composition.js'
import { createBridgeCommand, sha256Canonical } from '../server/dist-v4/modules/execution/index.js'
import { DEFAULT_RISK_POLICY, resolveRiskPolicy } from '../server/dist-v4/modules/risk/index.js'
import { subscriptionWindowFingerprint } from '../server/dist-v4/modules/strategies/index.js'
import { createStrategyExecutionConfigReader } from '../server/dist-v4/modules/strategies/composition.js'
import { loadCandidateTaskUpgrade } from './lib/candidate-task-upgrade.mjs'

const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination ?? ''))
const output = await open(destination, 'wx', 0o600), name = 'dev_vue_pending_ref_' + randomUUID().replaceAll('-', '')
const report = { kind: 'pending-preparation-mysql-reference/v1', passed: false, existingDatabaseWrites: 0, dataCopied: false,
  foreignKeysVerified: false, syntheticPorts: ['first-phase-reviewer'], checks: [] }
let db, pool, redis, created = false
const redisPrefix = 'pending-preparation-reference:' + randomUUID()
const redisKeys = [redisPrefix + ':user:7:connections', redisPrefix + ':user:7:profile:profile_12345678', redisPrefix + ':account:5', redisPrefix + ':connection:reference-connection']
try {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.ok(credentials.host === '127.0.0.1' && credentials.port === 13316 && credentials.user === 'root')
  db = await mysql.createConnection({ ...credentials, database: 'dev_vue', timezone: 'Z' })
  const [[identity]] = await db.query('SELECT @@server_uuid uuid,@@innodb_force_recovery recovery')
  assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104'); assert.equal(Number(identity.recovery), 0)
  const plan = await loadCandidateTaskUpgrade(new URL('../', import.meta.url))
  const [history] = await db.query('SELECT id,checksum_sha256 checksum,status FROM database_upgrade_steps_v4 ORDER BY id')
  assert.equal(history.length, plan.steps.length)
  const checksums = new Map(plan.steps.map(step => [step.id, step.checksum]))
  for (const row of history) { assert.equal(row.status, 'completed'); assert.equal(row.checksum, checksums.get(row.id)) }
  const tables = ['bridge_command_results_v4', 'execution_outcomes', 'users', 'trading_account_ownership_intervals', 'user_trading_account_settings', 'trading_projection_provenance_v4', 'pending_order_snapshots', 'trading_accounts', 'trading_account_ownerships', 'terminal_profiles', 'terminal_account_bindings', 'bridge_connection_sessions',
    'account_runtime_snapshots', 'execution_intents', 'execution_intent_payloads', 'execution_intent_events', 'bridge_commands_v4',
    'bridge_command_payloads_v4', 'bridge_command_events_v4', 'outbox_events', 'operations', 'operation_events', 'execution_distribution_targets',
    'execution_distributions', 'strategies', 'strategy_versions', 'strategy_subscriptions', 'subscription_schedules',
    'subscription_execution_preferences', 'risk_decisions_v4', 'trade_decisions', 'ai_trader_runs', 'inference_snapshots', 'inference_snapshot_payloads','risk_decision_payloads_v4','risk_policy_sets_v4','risk_policy_versions_v4','global_risk_controls','account_risk_states','account_risk_summaries','market_analyses','ai_analysis_runs','market_quotes','market_instrument_snapshots','trading_projection_revisions','risk_reservations_v4','risk_reservation_events_v4']
  const definitions = []
  for (const table of tables) {
    const [[row]] = await db.query('SHOW CREATE TABLE `' + table + '`')
    const original = row['Create Table']
    definitions.push({ table, sha256: createHash('sha256').update(original).digest('hex'),
      ddl: original.split('\n').filter(line => !line.includes('FOREIGN KEY')).join('\n').replace(/,\n\)/g, '\n)') })
  }
  await db.query('CREATE DATABASE `' + name + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'); created = true
  await db.query('USE `' + name + '`')
  for (const definition of definitions) await db.query(definition.ddl)
  report.tables = definitions.map(({ table, sha256 }) => ({ table, sha256 }))
  pool = mysql.createPool({ ...credentials, database: name, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true, connectionLimit: 3 })
  const at = new Date(), sqlTime = at.toISOString().slice(0, 23).replace('T', ' '), expiry = new Date(at.getTime() + 120000)
  const insert = async (table, values) => {
    report.fixtureTable = table
    assert.ok(tables.includes(table))
    const [columns] = await db.execute('SELECT COLUMN_NAME name,DATA_TYPE type,COLUMN_TYPE definition,IS_NULLABLE nullable,COLUMN_DEFAULT fallback,EXTRA extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [name, table])
    const row = { ...values }
    // Synthetic fixtures only; required unrelated fields use deterministic values.
    for (const col of columns) {
      if (Object.hasOwn(row, col.name) || col.nullable === 'YES' || col.fallback !== null || /auto_increment|GENERATED/.test(col.extra)) continue
      row[col.name] = col.type === 'enum' ? /^enum\('([^']+)'/.exec(col.definition)[1]
        : col.type === 'json' ? '{}' : ['datetime', 'timestamp'].includes(col.type) ? sqlTime
          : /int|decimal|float|double/.test(col.type) ? 1 : col.name.includes('sha256') ? 'a'.repeat(64) : 'fixture'
    }
    const keys = Object.keys(row); assert.ok(keys.every(key => /^[a-z][a-z0-9_]*$/.test(key)))
    await db.execute(`INSERT INTO ${table} (${keys.map(key => '`' + key + '`').join(',')}) VALUES (${keys.map(() => '?').join(',')})`, Object.values(row))
  }
  const route = { terminalInstanceId: 'terminal_12345678', brokerServer: 'Synthetic Broker', login: '001', connectionEpoch: 3 }
  await insert('users', { id: 7, deletion_status: 'active' })
  await insert('trading_accounts', { id: 5, platform: 'mt5', broker_server: route.brokerServer, account_login: route.login, currency: 'USD' })
  const intervalId = randomUUID()
  await insert('trading_account_ownership_intervals', { id: intervalId, user_id: 7, trading_account_id: 5, role: 'owner', started_at_utc: sqlTime })
  await insert('trading_account_ownerships', { user_id: 7, trading_account_id: 5, interval_id: intervalId, granted_at_utc: sqlTime })
  await insert('terminal_profiles', { id: 'profile_12345678', user_id: 7, platform: 'mt5' })
  await insert('terminal_account_bindings', { terminal_profile_id: 'profile_12345678', trading_account_id: 5, terminal_instance_id: route.terminalInstanceId })
  await insert('bridge_connection_sessions', { user_id: 7, trading_account_id: 5, terminal_profile_id: 'profile_12345678', terminal_instance_id: route.terminalInstanceId, connection_epoch: '3', connection_epoch_v4: 3 })
  await insert('account_runtime_snapshots', { trading_account_id: 5, trade_permission: 1, clock_status: 'calibrated' })
  const prompt = 'Synthetic reference', promptHash = createHash('sha256').update(prompt).digest('hex'), config = {}, window = { enabled: false }
  const snapshot = { kind: 'trader', strategy: { id: '20', versionId: '21', promptHash }, strategyConfigHash: sha256Canonical(config),
    subscriptionRevision: 1, subscriptionWindowHash: subscriptionWindowFingerprint(window, 'UTC'), executionPreferences: { contractVersion: 1, takeProfitMode: 'ai_recommended', revision: '1' } }
  await insert('strategies', { id: 20, kind: 'trader', scope: 'user', owner_user_id: 7, status: 'active', active_version_id: 21 })
  await insert('strategy_versions', { id: 21, strategy_id: 20, version_number: 1, prompt_text: prompt, prompt_sha256: promptHash, config_json: '{}' })
  await insert('strategy_subscriptions', { id: 8, user_id: 7, trading_account_id: 5, trader_strategy_id: 20, trader_strategy_version_id: 21, status: 'active', trader_enabled: 1, trade_send_enabled: 1 })
  await insert('subscription_schedules', { subscription_id: 8, receive_timezone: 'UTC', receive_window_json: JSON.stringify(window) })
  await insert('subscription_execution_preferences', { subscription_id: 8, contract_version: 1, take_profit_mode: 'ai_recommended', revision: 1 })
  await insert('inference_snapshots', { id: 'snapshot', user_id: 7, trading_account_id: 5, purpose: 'trader', strategy_id: 20, strategy_version_id: 21, payload_sha256: sha256Canonical(snapshot) })
  await insert('inference_snapshot_payloads', { snapshot_id: 'snapshot', encoding: 'json', payload_json: JSON.stringify(snapshot) })
  await insert('ai_trader_runs', { id: 'run', user_id: 7, trading_account_id: 5, strategy_id: 20, strategy_version_id: 21, subscription_id: 8, subscription_revision: 1, input_snapshot_id: 'snapshot', status: 'succeeded' })
  await insert('trade_decisions', { id: 'decision', trader_run_id: 'run', user_id: 7, trading_account_id: 5, strategy_id: 20, strategy_version_id: 21, input_snapshot_id: 'snapshot', status: 'accepted', risk_decision_id: 'risk' })
  await insert('risk_decisions_v4', { id: 'risk', trade_decision_id: 'decision', user_id: 7, trading_account_id: 5, platform_policy_version_id: 1, decision_status: 'approved' })
  const action = { actionId: 'a1', kind: 'pending_order', parameters: { symbol: 'XAUUSD', type: 'buy_limit', price: '2500', volume: '0.01' },
    expectedState: { analysisRevision: 1, subscriptionRevision: 1, accountRevision: 1, positionsRevision: 0, pendingOrdersRevision: 0, quoteRevision: 1, contractRevision: 1, riskRevision: 1 } }
  const platform = { ...DEFAULT_RISK_POLICY, tradeSendEnabled: true }
  const policy = resolveRiskPolicy({ userId: 7, accountId: '5', platformPolicyVersionId: '1', accountPolicyVersionId: '2', policySetRevision: 1,
    platform: { values: platform, globalKillSwitch: false, revision: 1 }, account: { tradeSendEnabled: true }, updatedAt: at.toISOString() })
  await insert('risk_policy_sets_v4', { id: 1, scope: 'platform', status: 'active', active_version_id: 1, revision: 1 })
  await insert('risk_policy_versions_v4', { id: 1, policy_set_id: 1, policy_json: JSON.stringify(platform) })
  await insert('risk_policy_sets_v4', { id: 2, scope: 'account', owner_user_id: 7, trading_account_id: 5, status: 'active', active_version_id: 2, revision: 1 })
  await insert('risk_policy_versions_v4', { id: 2, policy_set_id: 2, policy_json: JSON.stringify({ tradeSendEnabled: true }) })
  await insert('global_risk_controls', { id: 1, kill_switch: 0, revision: 1 })
  await insert('market_analyses', { id: 'analysis', standard_symbol: 'XAUUSD', revision: 1, owner_scope: 'user', owner_user_id: 7, analyzed_at_utc: sqlTime, valid_until_utc: expiry })
  await db.execute("UPDATE trade_decisions SET market_analysis_id='analysis' WHERE id='decision'")
  await insert('market_quotes', { trading_account_id: 5, symbol: 'XAUUSD', revision: 1 })
  const instrumentData = { tick_size: '0.01', point: '0.01', sourceEvidence: { userId: 7,
    terminalProfileId: 'profile_12345678', terminalInstanceId: route.terminalInstanceId, connectionEpoch: '3', ownershipRevision: '1' } }
  await insert('market_instrument_snapshots', { trading_account_id: 5, symbol: 'XAUUSD', revision: 1, payload_json: JSON.stringify(instrumentData) })
  await insert('account_risk_summaries', { trading_account_id: 5, revision: 1 })
  await insert('account_risk_states', { trading_account_id: 5, revision: 1, open_positions: 0, pending_orders: 0, total_volume: 0, daily_open_count: 0 })
  const evaluation = { manualReleaseId: null, manualReleaseRevision: null, evaluatedAt: at.toISOString(), approvedActions: [action],
    rules: [{ code: 'RISK_ACTION_APPROVED', actionId: 'a1', outcome: 'passed', details: { risk_amount: 1, risk_percent: 0.1, volume: 0.01 } }] }
  await insert('risk_decision_payloads_v4', { risk_decision_id: 'risk', evaluation_json: JSON.stringify(evaluation) })
  await db.execute("UPDATE risk_decisions_v4 SET policy_sha256=?,account_policy_version_id=2,policy_set_revision=1,account_risk_revision=1 WHERE id='risk'", [riskPolicyHash(policy)])
  let mode = 'reject', reviews = 0
  const repository = new MysqlExecutionRepository(pool, createTransactionAccountClock, createTransactionRiskDecisionExecutionWriter, createStrategyExecutionConfigReader, () => ({ async review() { reviews++; if (mode === 'reject') throw Object.assign(new Error('execution_duplicate_prepared_pending'), { code: 'execution_duplicate_prepared_pending' }) } }))
  const service = new ExecutionService(repository)
  const effectTables = ['operations','operation_events','execution_intents','execution_intent_payloads','execution_intent_events','risk_reservations_v4','risk_reservation_events_v4','outbox_events']
  const counts = async () => Promise.all(effectTables.map(async table => { const [[row]] = await db.query('SELECT COUNT(*) n FROM ' + table); return Number(row.n) }))
  await assert.rejects(service.prepare(7, 'risk'), { code: 'execution_duplicate_prepared_pending' })
  assert.equal(reviews, 1); assert.ok((await counts()).every(n => n === 0))
  report.checks.push('preparation-rejection-rolls-back-all-eight-output-tables')
  mode = 'allow'
  const result = await service.prepare(7, 'risk')
  assert.equal(result.kind, 'prepared'); assert.equal(result.intents.length, 1); assert.equal(result.reservations.length, 1)
  const committed = await counts(); assert.ok(committed.every(n => n > 0))
  report.checks.push('preparation-persists-intent-reservation-events-and-outbox')
  mode = 'reject'
  const replay = await service.prepare(7, 'risk')
  assert.equal(replay.operation.id, result.operation.id); assert.deepEqual(await counts(), committed); assert.equal(reviews, 2)
  report.checks.push('idempotent-replay-skips-new-review-and-writes')
  for (const [label, change, restore] of [
    ['changed-approved-action', "UPDATE risk_decision_payloads_v4 SET evaluation_json=JSON_SET(evaluation_json,'$.approvedActions[0].parameters.price','2501') WHERE risk_decision_id='risk'", "UPDATE risk_decision_payloads_v4 SET evaluation_json=JSON_SET(evaluation_json,'$.approvedActions[0].parameters.price','2500') WHERE risk_decision_id='risk'"],
    ['extra-risk-revision', "UPDATE risk_decisions_v4 SET revision=3 WHERE id='risk'", "UPDATE risk_decisions_v4 SET revision=2 WHERE id='risk'"],
    ['wrong-operation-link', "UPDATE risk_decisions_v4 SET operation_id='wrong-operation' WHERE id='risk'", null],
  ]) {
    await db.execute(change)
    try {
      await assert.rejects(service.prepare(7, 'risk'), { code: 'execution_persistence_conflict' })
      assert.deepEqual(await counts(), committed); assert.equal(reviews, 2)
    } finally {
      if (restore) await db.execute(restore)
      else await db.execute("UPDATE risk_decisions_v4 SET operation_id=? WHERE id='risk'", [result.operation.id])
    }
    report.checks.push('replay-' + label + '-rejected-without-writes')
  }
  assert.equal((await service.prepare(7, 'risk')).operation.id, result.operation.id)
  const expired = await service.expire(new Date(at.getTime() + 600000), 100)
  assert.equal(expired.length, 1); assert.equal(expired[0].status, 'expired')
  const [[reservation]] = await db.query('SELECT status FROM risk_reservations_v4'); assert.equal(reservation.status, 'expired')
  report.checks.push('prepared-expiry-releases-reservation-with-UTC-timestamps')
  const afterExpiry = await counts()
  const expiredReplay = await service.prepare(7, 'risk', new Date(at.getTime() + 600000))
  assert.equal(expiredReplay.operation.id, result.operation.id)
  assert.equal(expiredReplay.operation.status, 'expired')
  assert.ok(expiredReplay.intents.every(intent => intent.status === 'expired'))
  assert.ok(expiredReplay.reservations.every(reservation => reservation.status === 'expired'))
  assert.deepEqual(await counts(), afterExpiry); assert.equal(reviews, 2)
  await assert.rejects(service.prepare(8, 'risk', new Date(at.getTime() + 600000)), { code: 'execution_source_not_found' })
  report.checks.push('expired-replay-returns-original-terminal-state-without-new-writes-or-cross-user-access')
  await insert('trading_projection_revisions', { trading_account_id: 5, resource_kind: 'pending_orders', resource_id: 'open', revision: 1 })
  await insert('trading_projection_provenance_v4', { trading_account_id: 5, resource_kind: 'pending_orders', resource_id: 'open',
    user_id: 7, ownership_interval_id: intervalId, ownership_revision: 1, terminal_profile_id: 'profile_12345678',
    terminal_instance_id: route.terminalInstanceId, connection_epoch: 3, projection_revision: 1, observed_at_utc: sqlTime })
  await insert('strategies', { id: 22, kind: 'analysis', scope: 'user', owner_user_id: 7, status: 'active', active_version_id: 23 })
  await insert('strategy_versions', { id: 23, strategy_id: 22, version_number: 1, prompt_text: 'Analysis reference', prompt_sha256: createHash('sha256').update('Analysis reference').digest('hex'), config_json: '{}' })
  const frozenMarket = { symbol: 'XAUUSD', candles: { H1: Array.from({ length: 15 }, (_, index) => ({
    open_time: new Date(at.getTime() - (16 - index) * 3600000).toISOString(), closed: true, open: '2500', high: '2505', low: '2495', close: '2500',
  })) } }
  for (const suffix of ['one', 'two']) {
    const analysisId = 'analysis-' + suffix, decisionId = 'decision-' + suffix, riskId = 'risk-' + suffix
    await insert('market_analyses', { id: analysisId, analysis_run_id: 'analysis-run-' + suffix, standard_symbol: 'XAUUSD', revision: 1,
      owner_scope: 'user', owner_user_id: 7, analyzed_at_utc: sqlTime, valid_until_utc: expiry })
    const analysisSnapshot = { kind: 'analysis', strategy: { id: '22', versionId: '23' }, market: frozenMarket, capturedAt: at.toISOString() }
    await insert('inference_snapshots', { id: 'analysis-snapshot-' + suffix, user_id: 7, trading_account_id: null, purpose: 'analysis',
      strategy_id: 22, strategy_version_id: 23, standard_symbol: 'XAUUSD', payload_sha256: sha256Canonical(analysisSnapshot) })
    await insert('inference_snapshot_payloads', { snapshot_id: 'analysis-snapshot-' + suffix, encoding: 'json', payload_json: JSON.stringify(analysisSnapshot) })
    await insert('ai_analysis_runs', { id: 'analysis-run-' + suffix, user_id: 7, strategy_id: 22, strategy_version_id: 23,
      standard_symbol: 'XAUUSD', input_snapshot_id: 'analysis-snapshot-' + suffix, status: 'succeeded', idempotency_key: 'analysis-' + suffix })
    await db.execute('UPDATE market_analyses SET strategy_id=22,strategy_version_id=23,input_snapshot_id=? WHERE id=?', ['analysis-snapshot-' + suffix, analysisId])
    await insert('ai_trader_runs', { id: 'run-' + suffix, market_analysis_id: analysisId, idempotency_key: suffix, user_id: 7, trading_account_id: 5,
      strategy_id: 20, strategy_version_id: 21, subscription_id: 8, subscription_revision: 1, input_snapshot_id: 'snapshot', status: 'succeeded' })
    await insert('trade_decisions', { id: decisionId, trader_run_id: 'run-' + suffix, market_analysis_id: analysisId, user_id: 7, trading_account_id: 5,
      strategy_id: 20, strategy_version_id: 21, input_snapshot_id: 'snapshot', status: 'accepted', risk_decision_id: riskId })
    await insert('risk_decisions_v4', { id: riskId, trade_decision_id: decisionId, user_id: 7, trading_account_id: 5, platform_policy_version_id: 1,
      account_policy_version_id: 2, policy_set_revision: 1, account_risk_revision: 1, policy_sha256: riskPolicyHash(policy), decision_status: 'approved' })
    const candidateAction = { ...action, parameters: { ...action.parameters, price: suffix === 'one' ? '2500' : '2500.001' }, expectedState: { ...action.expectedState, pendingOrdersRevision: 1 } }
    await insert('risk_decision_payloads_v4', { risk_decision_id: riskId, evaluation_json: JSON.stringify({ ...evaluation, approvedActions: [candidateAction] }) })
  }
  const terminalWindow = { version: 1, enabled: true, timezone: 'terminal_server', weekdays: [0,1,2,3,4,5,6],
    windows: [{ start: '00:00', end: '00:00' }], outsideBehavior: 'pause_all' }
  const clockSnapshot = { ...snapshot, subscriptionWindowHash: subscriptionWindowFingerprint(terminalWindow, 'terminal_server') }
  await db.execute('UPDATE subscription_schedules SET receive_timezone=?,receive_window_json=? WHERE subscription_id=8', ['terminal_server', JSON.stringify(terminalWindow)])
  await db.execute("UPDATE inference_snapshots SET payload_sha256=? WHERE id='snapshot'", [sha256Canonical(clockSnapshot)])
  await db.execute("UPDATE inference_snapshot_payloads SET payload_json=? WHERE snapshot_id='snapshot'", [JSON.stringify(clockSnapshot)])
  await db.execute('UPDATE account_runtime_snapshots SET timezone_offset_minutes=180 WHERE trading_account_id=5')
  await insert('trading_projection_revisions', { trading_account_id: 5, resource_kind: 'account.metrics', resource_id: 'current', revision: 1 })
  await insert('trading_projection_provenance_v4', { trading_account_id: 5, resource_kind: 'account.metrics', resource_id: 'current',
    user_id: 7, ownership_interval_id: intervalId, ownership_revision: 1, terminal_profile_id: 'profile_12345678',
    terminal_instance_id: route.terminalInstanceId, connection_epoch: 3, projection_revision: 1, observed_at_utc: sqlTime })
  const env = parseEnv(await readFile(new URL('../server/.env', import.meta.url)))
  assert.equal(env.REDIS_HOST, '192.168.1.254')
  redis = new Redis({ host: env.REDIS_HOST, port: Number(env.REDIS_PORT || 6379), db: Number(env.REDIS_DB || 0),
    password: env.REDIS_PASSWORD || undefined, connectTimeout: 5000, maxRetriesPerRequest: 1, retryStrategy: () => null })
  redis.on('error', () => {})
  await redis.ping()
  const leases = new RedisBridgeGatewayLeaseStore(redis, redisPrefix)
  const leaseRoute = { ...route, userId: 7, accountId: '5', terminalProfileId: 'profile_12345678', platform: 'mt5',
    timezoneOffsetMinutes: 180, connectionId: 'reference-connection', sessionId: 'reference-session', ownershipRevision: '1' }
  await leases.claim({ route: leaseRoute, capacity: 1, ttlSeconds: 120 })
  assert.deepEqual(await leases.current('5'), leaseRoute)
  report.redis = { host: env.REDIS_HOST, db: Number(env.REDIS_DB || 0), isolatedPrefix: redisPrefix, existingKeyWrites: 0 }
  const integrated = new ExecutionService(new MysqlExecutionRepository(pool, createTransactionAccountClock, createTransactionRiskDecisionExecutionWriter, createStrategyExecutionConfigReader, connection => createMysqlPendingPreparationReviewer(connection, {
    routes: leases,
    decisions: createTransactionTradeDecisionOriginReader(connection),
    analyses: createTransactionTradeDecisionAnalysisReader(connection),
    instruments: createMysqlInstrumentSnapshotReader(connection),
    pending: createTransactionPendingReader(connection),
  })))
  await db.beginTransaction()
  try {
    const proof = await createTransactionTradeDecisionAnalysisReader(db).read({ userId: 7, accountId: '5', decisionId: 'decision-one', riskDecisionId: 'risk-one' })
    assert.ok(proof); assert.equal(proof.atr.status, 'available'); assert.equal(proof.atr.value, '10'); assert.equal(proof.strategyId, '20')
    report.checks.push('real-SQL-frozen-analysis-ATR-and-trader-origin')
  } finally { await db.rollback() }
  const beforeTamper = await counts()
  await assert.rejects(integrated.prepare(7, 'risk-one', new Date(at.getTime() + 600000)), { code: 'execution_source_expired' })
  assert.deepEqual(await counts(), beforeTamper)
  report.checks.push('never-prepared-expired-source-cannot-create-new-intents')
  await db.execute("UPDATE inference_snapshot_payloads SET payload_json=JSON_SET(payload_json,'$.market.symbol','WRONG') WHERE snapshot_id='analysis-snapshot-one'")
  await assert.rejects(integrated.prepare(7, 'risk-one'), { code: 'execution_dedup_context_invalid' })
  assert.deepEqual(await counts(), beforeTamper)
  await db.execute("UPDATE inference_snapshot_payloads SET payload_json=JSON_SET(payload_json,'$.market.symbol','XAUUSD') WHERE snapshot_id='analysis-snapshot-one'")
  report.checks.push('tampered-frozen-snapshot-rejected-without-output-writes')
  const instrumentReader = createMysqlInstrumentSnapshotReader(db)
  assert.deepEqual(await instrumentReader.read('5', 'XAUUSD'), { revision: 1, data: instrumentData })
  report.checks.push('real-SQL-instrument-owner-binding-session-and-freshness')
  for (const [label, change, restore] of [
    ['wrong-owner', "UPDATE market_instrument_snapshots SET payload_json=JSON_SET(payload_json,'$.sourceEvidence.userId',8)", "UPDATE market_instrument_snapshots SET payload_json=JSON_SET(payload_json,'$.sourceEvidence.userId',7)"],
    ['wrong-epoch', "UPDATE market_instrument_snapshots SET payload_json=JSON_SET(payload_json,'$.sourceEvidence.connectionEpoch','4')", "UPDATE market_instrument_snapshots SET payload_json=JSON_SET(payload_json,'$.sourceEvidence.connectionEpoch','3')"],
    ['disconnected-session', 'UPDATE bridge_connection_sessions SET disconnected_at_utc=UTC_TIMESTAMP(3)', 'UPDATE bridge_connection_sessions SET disconnected_at_utc=NULL'],
    ['stale-instrument', 'UPDATE market_instrument_snapshots SET observed_at_utc=UTC_TIMESTAMP(3)-INTERVAL 301 SECOND', 'UPDATE market_instrument_snapshots SET observed_at_utc=UTC_TIMESTAMP(3)'],
  ]) {
    // Mutations target only the isolated synthetic reference database selected above.
    await db.execute(change)
    try {
      assert.equal(await instrumentReader.read('5', 'XAUUSD'), null)
      await assert.rejects(integrated.prepare(7, 'risk-one'), { code: 'execution_dedup_context_invalid' })
      assert.deepEqual(await counts(), beforeTamper)
    } finally { await db.execute(restore) }
    report.checks.push('instrument-' + label + '-rejected-without-output-writes')
  }
  const pendingReader = createTransactionPendingReader(db)
  const pendingContext = { userId: 7, accountId: '5', ...route, connectionEpoch: '3', ownershipRevision: '1' }
  assert.deepEqual(await pendingReader.read(pendingContext), { ...pendingContext, revision: '1', observedAt: at.toISOString(), complete: true, items: [] })
  report.checks.push('real-SQL-empty-pending-projection-has-valid-ownership-and-provenance')
  for (const [label, change, restore, code] of [
    ['wrong-epoch', "UPDATE trading_projection_provenance_v4 SET connection_epoch=4 WHERE resource_kind='pending_orders'", "UPDATE trading_projection_provenance_v4 SET connection_epoch=3 WHERE resource_kind='pending_orders'", 'execution_dedup_snapshot_incomplete'],
    ['mixed-revision', "UPDATE trading_projection_provenance_v4 SET projection_revision=2 WHERE resource_kind='pending_orders'", "UPDATE trading_projection_provenance_v4 SET projection_revision=1 WHERE resource_kind='pending_orders'", 'execution_dedup_snapshot_incomplete'],
    ['stale', "UPDATE trading_projection_provenance_v4 SET observed_at_utc=UTC_TIMESTAMP(3)-INTERVAL 301 SECOND WHERE resource_kind='pending_orders'", "UPDATE trading_projection_provenance_v4 SET observed_at_utc=UTC_TIMESTAMP(3) WHERE resource_kind='pending_orders'", 'execution_dedup_snapshot_stale'],
  ]) {
    await db.execute(change)
    try {
      await assert.rejects(integrated.prepare(7, 'risk-one'), { code })
      assert.deepEqual(await counts(), beforeTamper)
    } finally {
      if (label === 'stale') await db.execute("UPDATE trading_projection_provenance_v4 SET observed_at_utc=? WHERE resource_kind='pending_orders'", [sqlTime])
      else await db.execute(restore)
    }
    report.checks.push('pending-projection-' + label + '-rejected-without-output-writes')
  }
  assert.deepEqual(await createTransactionAccountClock(db).read(7, '5'), { timezoneOffsetMinutes: 180, clockStatus: 'calibrated' })
  for (const status of ['stale', 'unavailable', 'observer_bootstrap']) {
    await db.execute('UPDATE account_runtime_snapshots SET clock_status=? WHERE trading_account_id=5', [status])
    try {
      await assert.rejects(integrated.prepare(7, 'risk-one'), { code: 'execution_schedule_closed' })
      assert.deepEqual(await counts(), beforeTamper)
    } finally { await db.execute("UPDATE account_runtime_snapshots SET clock_status='calibrated' WHERE trading_account_id=5") }
  }
  report.checks.push('real-SQL-terminal-clock-required-and-untrusted-clock-rejected')
  await leases.release(leaseRoute)
  try {
    assert.equal(await leases.current('5'), null)
    await assert.rejects(integrated.prepare(7, 'risk-one'), { code: 'execution_dedup_context_invalid' })
    assert.deepEqual(await counts(), beforeTamper)
  } finally { await leases.claim({ route: leaseRoute, capacity: 1, ttlSeconds: 120 }) }
  report.checks.push('real-redis-missing-route-rejected-without-output-writes')
  await leases.claim({ route: { ...leaseRoute, connectionEpoch: 4 }, capacity: 1, ttlSeconds: 120 })
  try {
    await assert.rejects(integrated.prepare(7, 'risk-one'), { code: 'execution_dedup_context_invalid' })
    assert.deepEqual(await counts(), beforeTamper)
  } finally { await leases.claim({ route: leaseRoute, capacity: 1, ttlSeconds: 120 }) }
  report.checks.push('real-redis-route-epoch-change-invalidates-instrument-evidence')
  const historicalIntent = randomUUID(), historicalCommand = randomUUID(), historicalOutcome = randomUUID()
  const historicalResult = { order_ticket: '9001' }, historicalHash = sha256Canonical(historicalResult)
  await db.execute("UPDATE ai_trader_runs SET market_analysis_id='analysis' WHERE id='run'")
  await insert('execution_intents', { id: historicalIntent, operation_id: result.operation.id, user_id: 7, trading_account_id: 5,
    source_type: 'risk_decision', source_id: 'risk', risk_decision_id: 'risk', trade_decision_id: 'decision', action_id: 'historical',
    action_kind: 'pending_order', status: 'succeeded', expires_at_utc: expiry, idempotency_key: 'c'.repeat(64) })
  await insert('bridge_commands_v4', { id: historicalCommand, execution_intent_id: historicalIntent, user_id: 7, trading_account_id: 5,
    terminal_profile_id: 'profile_12345678', terminal_instance_id: route.terminalInstanceId, broker_server: route.brokerServer,
    account_login: route.login, connection_epoch: 2, action: 'order.place', status: 'succeeded', deadline_at_utc: expiry,
    idempotency_key: 'c'.repeat(64), result_sha256: historicalHash })
  await insert('execution_outcomes', { id: historicalOutcome, execution_intent_id: historicalIntent, trading_account_id: 5,
    resource_kind: 'pending_order', ticket: '9001', status: 'succeeded', result_sha256: historicalHash, result_json: JSON.stringify(historicalResult) })
  const livePending = { accountId: '5', ticket: '9001', revision: '1', symbol: 'XAUUSD', type: 'buy_limit', price: '2500', volume: '0.01' }
  await insert('pending_order_snapshots', { trading_account_id: 5, ticket: '9001', revision: 1, payload_json: JSON.stringify(livePending) })
  const historyBaseline = await counts()
  const origins = createMysqlPendingOrderOriginReader(db, createTransactionTradeDecisionOriginReader(db))
  const originContext = { userId: 7, accountId: '5', ...route, connectionEpoch: '3', tickets: ['9001'] }
  assert.deepEqual(await origins.read(originContext), [{ ticket: '9001', status: 'strategy', userId: 7, accountId: '5', strategyId: '20' }])
  await assert.rejects(integrated.prepare(7, 'risk-one'), { code: 'execution_duplicate_live_pending' })
  assert.deepEqual(await counts(), historyBaseline)
  report.checks.push('live-pending-exact-ticket-historical-epoch-origin-blocks-duplicate-preparation')
  await db.execute("UPDATE ai_trader_runs SET strategy_version_id=99 WHERE id='run'")
  try {
    await assert.rejects(integrated.prepare(7, 'risk-one'), { code: 'execution_dedup_origin_invalid' })
    assert.deepEqual(await counts(), historyBaseline)
  } finally { await db.execute("UPDATE ai_trader_runs SET strategy_version_id=21 WHERE id='run'") }
  report.checks.push('live-pending-broken-decision-lineage-rejected-without-output-writes')
  await db.execute('UPDATE pending_order_snapshots SET revision=2 WHERE trading_account_id=5')
  try {
    await assert.rejects(integrated.prepare(7, 'risk-one'), { code: 'execution_dedup_snapshot_incomplete' })
    assert.deepEqual(await counts(), historyBaseline)
  } finally { await db.execute('UPDATE pending_order_snapshots SET revision=1 WHERE trading_account_id=5') }
  report.checks.push('live-pending-mixed-row-revision-rejected-without-output-writes')
  await db.execute('UPDATE bridge_commands_v4 SET connection_epoch=4 WHERE id=?', [historicalCommand])
  assert.deepEqual(await origins.read(originContext), [{ ticket: '9001', status: 'unresolved' }])
  report.checks.push('future-command-epoch-cannot-prove-live-pending-origin')
  await db.execute('DELETE FROM pending_order_snapshots WHERE trading_account_id=5 AND ticket=?', ['9001'])
  await db.execute('DELETE FROM execution_outcomes WHERE id=?', [historicalOutcome])
  await db.execute('DELETE FROM bridge_commands_v4 WHERE id=?', [historicalCommand])
  await db.execute('DELETE FROM execution_intents WHERE id=?', [historicalIntent])
  assert.deepEqual(await counts(), beforeTamper)
  const concurrent = await Promise.allSettled([integrated.prepare(7, 'risk-one'), integrated.prepare(7, 'risk-two')])
  report.concurrent = concurrent.map(result => result.status === 'fulfilled' ? { status: 'prepared' } : { status: 'rejected', code: result.reason?.code })
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(concurrent.find(result => result.status === 'rejected')?.reason.code, 'execution_duplicate_prepared_pending')
  const [[active]] = await db.query("SELECT COUNT(*) n FROM execution_intents WHERE status='prepared'")
  const [[reserved]] = await db.query("SELECT COUNT(*) n FROM risk_reservations_v4 WHERE status='active'")
  assert.equal(Number(active.n), 1); assert.equal(Number(reserved.n), 1)
  report.checks.push('real-reviewer-concurrent-nearby-preparations-create-only-one-intent-and-reservation')
  const [links] = await db.query("SELECT operation_id,revision FROM risk_decisions_v4 WHERE id IN ('risk-one','risk-two')")
  assert.equal(links.filter(row => row.operation_id !== null && Number(row.revision) === 2).length, 1)
  assert.equal(links.filter(row => row.operation_id === null && Number(row.revision) === 1).length, 1)
  report.checks.push('real-risk-writer-links-only-winner-and-increments-revision-once')
  const winner = concurrent.find(item => item.status === 'fulfilled').value
  const commandSource = new MysqlExecutionCommandSource(pool, { magic: 4000, deviation: 10 })
  const candidate = await commandSource.loadPrepared(winner.intents[0].id, new Date().toISOString())
  assert.ok(candidate)
  assert.equal(candidate.command.executionIntentId, winner.intents[0].id)
  assert.equal(candidate.command.action, 'order.place')
  assert.equal(candidate.command.params.order_type, 'buy_limit')
  assert.equal(candidate.command.params.price, winner.intents[0].action.parameters.price)
  assert.equal(candidate.command.deadlineAt, winner.intents[0].expiresAt)
  assert.equal(await commandSource.loadPrepared(winner.intents[0].id, new Date(at.getTime() + 600000).toISOString()), null)
  report.checks.push('real-command-source-maps-prepared-winner-and-refuses-expired-candidate')
  const commandRepository = new MysqlBridgeCommandRepository(pool, createTransactionAccountClock, createTransactionRiskPolicyReader,
    undefined, undefined, undefined, undefined, createStrategyExecutionConfigReader,
    connection => createMysqlPendingCommandReviewer(connection, { pending: createTransactionPendingReader(connection),
      instruments: createMysqlInstrumentSnapshotReader(connection), decisions: createTransactionTradeDecisionOriginReader(connection),
      analyses: createTransactionTradeDecisionAnalysisReader(connection) }))
  const commandService = new BridgeCommandService(commandRepository)
  const queuedCommand = await commandService.create(candidate.command)
  assert.equal(queuedCommand.status, 'queued')
  assert.equal((await commandService.create(candidate.command)).id, queuedCommand.id)
  const [[commandCounts]] = await db.query('SELECT COUNT(*) n FROM bridge_commands_v4 WHERE execution_intent_id=?', [winner.intents[0].id])
  assert.equal(Number(commandCounts.n), 1)
  report.checks.push('prepared-winner-creates-one-durable-command-with-real-reviewers-and-replays')
  // Persist a simulated dispatch; no transport or terminal is invoked.
  const dispatched = await commandRepository.markDispatched(queuedCommand.id, queuedCommand.revision, new Date().toISOString())
  assert.equal(dispatched.status, 'dispatched')
  const completedMs = Date.now()
  const envelope = { v: 4, message_id: randomUUID(), type: 'command.result', sent_at_utc_msc: completedMs,
    correlation_id: queuedCommand.id, route: queuedCommand.request.route,
    payload: { command_id: queuedCommand.id, action: 'order.place', status: 'succeeded', completed_at_utc_msc: completedMs,
      result: { order_ticket: '9100' }, error_code: null, terminal_code: null } }
  await assert.rejects(commandService.result(envelope, new Date(), { userId: 8, terminalProfileId: 'profile_12345678' }), { code: 'bridge_command_scope_mismatch' })
  const persisted = await commandService.result(envelope, new Date(), { userId: 7, terminalProfileId: 'profile_12345678' })
  assert.equal(persisted.command.status, 'succeeded'); assert.equal(persisted.disposition, 'persisted')
  assert.equal(persisted.acknowledgement.type, 'command.result_ack')
  const resultBaseline = await counts()
  assert.equal((await commandService.result(envelope, new Date(), { userId: 7, terminalProfileId: 'profile_12345678' })).disposition, 'duplicate')
  assert.deepEqual(await counts(), resultBaseline)
  const [[outcome]] = await db.query('SELECT status,resource_kind,ticket,revision FROM execution_outcomes WHERE execution_intent_id=?', [winner.intents[0].id])
  assert.equal(outcome.status, 'succeeded'); assert.equal(outcome.resource_kind, 'pending_order'); assert.equal(outcome.ticket, '9100'); assert.equal(Number(outcome.revision), 1)
  const [[settledReservation]] = await db.query('SELECT status FROM risk_reservations_v4 WHERE execution_intent_id=?', [winner.intents[0].id])
  assert.equal(settledReservation.status, 'committed')
  assert.equal((await service.operation(7, winner.operation.id)).status, 'succeeded')
  report.checks.push('simulated-result-persists-outcome-reservation-operation-before-ack-and-replays-once')
  report.passed = true
} catch (error) {
  report.constraint = /Check constraint '([^']+)'/.exec(String(error?.sqlMessage ?? ''))?.[1]; report.errorCode = error?.code ?? error?.name
  report.actualCode = error?.actual?.code
  report.locations = String(error?.stack ?? '').split('\n').filter(line => /^\s+at /.test(line)).slice(0, 3)
  process.exitCode = 1
} finally {
  if (redis) {
    try {
      assert.ok(redisKeys.every(key => key.startsWith(redisPrefix + ':')))
      await redis.del(...redisKeys)
      assert.equal(await redis.exists(...redisKeys), 0)
      report.referenceRedisKeysRemoved = true
    } finally { redis.disconnect() }
  }
  if (pool) await pool.end()
  if (db) { if (created) { assert.match(name, /^dev_vue_pending_ref_[a-f0-9]{32}$/); await db.query('DROP DATABASE `' + name + '`'); report.referenceDatabaseRemoved = true } await db.end() }
  report.observedAt = new Date().toISOString(); await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close()
  console.log(JSON.stringify({ passed: report.passed, errorCode: report.errorCode, actualCode: report.actualCode, checks: report.checks, referenceDatabaseRemoved: report.referenceDatabaseRemoved }))
}
