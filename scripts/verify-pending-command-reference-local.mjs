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
import { loadInstrumentSnapshotUpgrade } from './lib/instrument-snapshot-upgrade.mjs'

const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination ?? ''))
const output = await open(destination, 'wx', 0o600), name = 'dev_vue_pending_ref_' + randomUUID().replaceAll('-', '')
const report = { kind: 'pending-command-mysql-reference/v1', passed: false, existingDatabaseWrites: 0, dataCopied: false,
  foreignKeysVerified: false, syntheticPorts: ['policy', 'analysis', 'instrument', 'pending-projection', 'historical-origin'], checks: [] }
let db, pool, created = false
try {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.ok(credentials.host === '127.0.0.1' && credentials.port === 13316 && credentials.user === 'root')
  db = await mysql.createConnection({ ...credentials, database: 'dev_vue', timezone: 'Z' })
  const [[identity]] = await db.query('SELECT @@server_uuid uuid,@@innodb_force_recovery recovery')
  assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104'); assert.equal(Number(identity.recovery), 0)
  const plan = await loadInstrumentSnapshotUpgrade(new URL('../', import.meta.url))
  const [history] = await db.query('SELECT id,checksum_sha256 checksum,status FROM database_upgrade_steps_v4 ORDER BY id')
  assert.equal(history.length, plan.steps.length)
  const checksums = new Map(plan.steps.map(step => [step.id, step.checksum]))
  for (const row of history) { assert.equal(row.status, 'completed'); assert.equal(row.checksum, checksums.get(row.id)) }
  const tables = ['trading_accounts', 'trading_account_ownerships', 'terminal_profiles', 'terminal_account_bindings', 'bridge_connection_sessions',
    'account_runtime_snapshots', 'execution_intents', 'execution_intent_payloads', 'execution_intent_events', 'bridge_commands_v4',
    'bridge_command_payloads_v4', 'bridge_command_events_v4', 'outbox_events', 'operations', 'operation_events', 'execution_distribution_targets',
    'execution_distributions', 'strategies', 'strategy_versions', 'strategy_subscriptions', 'subscription_schedules',
    'subscription_execution_preferences', 'risk_decisions_v4', 'trade_decisions', 'ai_trader_runs', 'inference_snapshots', 'inference_snapshot_payloads']
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
  await insert('trading_accounts', { id: 5, platform: 'mt5', broker_server: route.brokerServer, account_login: route.login, currency: 'USD' })
  await insert('trading_account_ownerships', { user_id: 7, trading_account_id: 5 })
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
  const action = { actionId: 'a1', kind: 'pending_order', parameters: { symbol: 'XAUUSD', type: 'buy_limit', price: '2500', volume: '0.01' }, expectedState: { contractRevision: 5, pendingOrdersRevision: 4 } }
  const intentId = randomUUID(), operationId = randomUUID()
  await insert('operations', { id: operationId, user_id: 7, trading_account_id: 5, kind: 'trade_execution', status: 'queued', source_type: 'risk_decision', source_id: 'risk', idempotency_scope: 'risk_decision', idempotency_key: 'risk_decision:risk' })
  await insert('execution_intents', { id: intentId, operation_id: operationId, user_id: 7, trading_account_id: 5, source_type: 'risk_decision', source_id: 'risk', risk_decision_id: 'risk', trade_decision_id: 'decision', action_id: 'a1', action_kind: 'pending_order', status: 'prepared', expires_at_utc: expiry })
  await insert('execution_intent_payloads', { execution_intent_id: intentId, action_json: JSON.stringify(action), action_sha256: sha256Canonical(action), expected_state_json: JSON.stringify(action.expectedState) })
  const command = createBridgeCommand({ executionIntentId: intentId, commandSequence: 1, userId: 7, accountId: '5', terminalProfileId: 'profile_12345678', route,
    action: 'order.place', params: { symbol: 'XAUUSD', direction: 'buy', order_type: 'buy_limit', price: '2500', volume: '0.01', magic: 7, deviation: 20 }, expectedState: null, deadlineAt: expiry.toISOString() }, at)
  const origin = { userId: 7, accountId: '5', strategyId: '20', strategyVersionId: '21', decisionId: 'decision' }
  let complete = false
  const policy = resolveRiskPolicy({ userId: 7, accountId: '5', platformPolicyVersionId: '1', accountPolicyVersionId: null, policySetRevision: 1,
    platform: { values: DEFAULT_RISK_POLICY, globalKillSwitch: false, revision: 1 }, account: { tradeSendEnabled: true }, updatedAt: at.toISOString() })
  const readPrepared = async () => {
    await db.beginTransaction()
    try {
      await db.execute('SELECT id FROM trading_accounts WHERE id=5 FOR UPDATE')
      return await createMysqlPreparedPendingOccupancyReader(db, { read: async () => origin }).read({ userId: 7, accountId: '5', strategyId: '20' })
    } finally { await db.rollback() }
  }
  assert.deepEqual((await readPrepared()).items.map(item => item.intentId), [intentId])
  report.checks.push('prepared-intent-without-command-is-occupied')
  const repository = new MysqlBridgeCommandRepository(pool, () => ({ read: async () => { throw Error('unexpected_clock') } }),
    () => ({ getEffectivePolicy: async () => policy }), undefined, undefined, undefined, undefined, createStrategyExecutionConfigReader,
    connection => createMysqlPendingCommandReviewer(connection, {
      decisions: { read: async () => origin }, analyses: { read: async () => ({ ...origin, symbol: 'XAUUSD', atr: { status: 'available', value: '10' } }) },
      instruments: { read: async () => ({ revision: 5, data: { tick_size: '0.01', point: '0.01', sourceEvidence: { userId: 7, terminalProfileId: command.terminalProfileId, terminalInstanceId: route.terminalInstanceId, connectionEpoch: '3', ownershipRevision: '1' } } }) },
      pending: { read: async () => complete ? { userId: 7, accountId: '5', ...route, connectionEpoch: '3', ownershipRevision: '1', revision: '4', observedAt: at.toISOString(), complete: true, items: [] } : null },
    }))
  const counts = async () => Promise.all(['bridge_commands_v4', 'bridge_command_payloads_v4', 'bridge_command_events_v4', 'outbox_events'].map(async table => {
    const [[row]] = await db.query('SELECT COUNT(*) n FROM ' + table); return Number(row.n)
  }))
  await assert.rejects(repository.create(command), { code: 'execution_dedup_snapshot_incomplete' })
  assert.deepEqual(await counts(), [0, 0, 0, 0]); report.checks.push('creation-rollback-no-partial-command')
  assert.equal((await readPrepared()).items.length, 1)
  complete = true
  await repository.create(command)
  assert.deepEqual(await counts(), [1, 1, 1, 1]); report.checks.push('creation-commits-command-payload-event-outbox')
  assert.equal((await readPrepared()).items.length, 1); report.checks.push('queued-command-keeps-one-intent-occupancy')
  await repository.create(command)
  assert.deepEqual(await counts(), [1, 1, 1, 1]); report.checks.push('independent-transaction-idempotent-replay')
  const priorIntent = randomUUID(), priorCommand = randomUUID(), priorAction = { ...action, actionId: 'a2', parameters: { ...action.parameters, price: '2500.1' } }
  await insert('execution_intents', { id: priorIntent, operation_id: operationId, user_id: 7, trading_account_id: 5, source_type: 'risk_decision', source_id: 'risk',
    risk_decision_id: 'risk', trade_decision_id: 'decision', action_id: 'a2', action_kind: 'pending_order', status: 'succeeded', expires_at_utc: expiry, idempotency_key: 'b'.repeat(64) })
  await insert('execution_intent_payloads', { execution_intent_id: priorIntent, action_json: JSON.stringify(priorAction), action_sha256: sha256Canonical(priorAction), expected_state_json: JSON.stringify(action.expectedState) })
  await insert('bridge_commands_v4', { id: priorCommand, execution_intent_id: priorIntent, user_id: 7, trading_account_id: 5, terminal_profile_id: command.terminalProfileId,
    terminal_instance_id: route.terminalInstanceId, broker_server: route.brokerServer, account_login: route.login, connection_epoch: 3, action: 'order.place',
    status: 'succeeded', deadline_at_utc: expiry, idempotency_key: 'b'.repeat(64) })
  await assert.rejects(repository.markDispatched(command.id, 1, new Date().toISOString()), { code: 'execution_duplicate_pending_dispatch' })
  assert.equal((await repository.get(command.id)).status, 'queued')
  report.checks.push('real-command-occupancy-rejects-nearby-pending-before-dispatch')
  await db.execute('DELETE FROM bridge_commands_v4 WHERE id=?', [priorCommand])
  await db.execute('DELETE FROM execution_intent_payloads WHERE execution_intent_id=?', [priorIntent])
  await db.execute('DELETE FROM execution_intents WHERE id=?', [priorIntent])
  complete = false
  await assert.rejects(repository.markDispatched(command.id, 1, new Date().toISOString()), { code: 'execution_dedup_snapshot_incomplete' })
  assert.equal((await repository.get(command.id)).status, 'queued')
  const [[intent]] = await db.execute('SELECT status,revision FROM execution_intents WHERE id=?', [intentId])
  assert.equal(intent.status, 'prepared'); assert.equal(Number(intent.revision), 1)
  report.checks.push('dispatch-rechecks-and-rolls-back-status-change')
  complete = true
  await repository.markDispatched(command.id, 1, new Date().toISOString())
  assert.equal((await repository.get(command.id)).status, 'dispatched')
  const [[after]] = await db.execute('SELECT status FROM execution_intents WHERE id=?', [intentId]); assert.equal(after.status, 'dispatching')
  report.checks.push('dispatch-commits-command-and-intent-together')
  assert.equal((await readPrepared()).items.length, 0); report.checks.push('dispatched-intent-leaves-prepared-reader-for-dispatch-reader')
  report.passed = true
} catch (error) {
  report.errorCode = error?.code ?? error?.name
  report.actualCode = error?.actual?.code
  report.locations = String(error?.stack ?? '').split('\n').filter(line => /^\s+at /.test(line)).slice(0, 3)
  process.exitCode = 1
} finally {
  if (pool) await pool.end()
  if (db) { if (created) { assert.match(name, /^dev_vue_pending_ref_[a-f0-9]{32}$/); await db.query('DROP DATABASE `' + name + '`'); report.referenceDatabaseRemoved = true } await db.end() }
  report.observedAt = new Date().toISOString(); await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close()
  console.log(JSON.stringify({ passed: report.passed, errorCode: report.errorCode, actualCode: report.actualCode, checks: report.checks, referenceDatabaseRemoved: report.referenceDatabaseRemoved }))
}
