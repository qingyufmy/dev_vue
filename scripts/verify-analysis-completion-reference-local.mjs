import { createBridgeCommandProcessor } from '../server/dist-v4/queue/bridge-command-processor.js'
import { replayChanCalculation } from '../server/dist-v4/modules/market/index.js'
import { verifyReviewMemoryConfirmation } from './lib/review-memory-confirmation-reference.mjs'
import { MysqlRuntimeModelProfileCatalog } from '../server/dist-v4/modules/inference/infrastructure/mysql-model-gateway-resolver.js'
import { HttpJsonAnalysisModelGateway, HttpJsonTraderModelGateway } from '../server/dist-v4/modules/inference/infrastructure/http-json-model-gateway.js'
import { createStrategyReferencePortfolioReader } from '../server/dist-v4/bootstrap/strategy-reference-evidence.js'
import { RedisBridgeGatewayLeaseStore } from '../server/dist-v4/modules/bridge/infrastructure/redis-bridge-gateway-lease-store.js'
import { createActivePrincipalAccess, createAccountPrincipalReader } from '../server/dist-v4/modules/auth/composition.js'
import { createMysqlRuntimeMemoryPreparationWriter, createMysqlRuntimeStrategyMemoryReader } from '../server/dist-v4/modules/reviews/composition.js'
import Redis from 'ioredis'
import { createExecutionProcessor } from '../server/dist-v4/queue/execution-processor.js'
import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { randomUUID, createHash, randomBytes, createCipheriv } from 'node:crypto'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { createMysqlModelUsageLedger, createAnalysisMarketSource, createAnalysisWindowGuard, createMysqlMacroSnapshotReader, createAnalysisScheduler, createMysqlTraderContext, createMysqlInferenceRepository, createMysqlTraderWindowGuard, createMysqlTradeDecisionRiskWriter, createDecisionStrategyEvidenceReader } from '../server/dist-v4/modules/inference/composition.js'
import { AnalysisWorker, AnalysisContextBuilder, TraderWorker, InferenceService, contentHash } from '../server/dist-v4/modules/inference/index.js'
import { createRuntimeStrategyAccess, createAnalysisWindowReader, createMysqlAnalysisScheduleStore, createAnalysisSubscriberReader, createSubscriptionPreferencesReader, createSubscriptionExecutionWindowReader, createStrategyExecutionConfigReader, createMysqlStrategyService } from '../server/dist-v4/modules/strategies/composition.js'
import { createAccountRiskSummaryReader, createRiskReviewWorker, createTransactionRiskDecisionExecutionWriter, createTransactionRiskPolicyReader } from '../server/dist-v4/modules/risk/composition.js'
import { MysqlExecutionRepository, RedisAccountExecutionLeaseStore, MysqlExecutionCommandSource, MysqlBridgeCommandRepository, createExecutionHttp } from '../server/dist-v4/modules/execution/composition.js'
import { ExecutionService, BridgeCommandService, ExecutionPreparationWorker } from '../server/dist-v4/modules/execution/index.js'
import Fastify from 'fastify'
import { DEFAULT_RISK_POLICY } from '../server/dist-v4/modules/risk/index.js'
import { createTradingReader, createMysqlInstrumentCollectionRequester, createMysqlInstrumentSnapshotReader, createAccountInventorySummaryReader } from '../server/dist-v4/modules/trading/composition.js'
import { MysqlOutboxRepository } from '../server/dist-v4/outbox/infrastructure/mysql-outbox-repository.js'
import { BullMqOutboxTaskPublisher } from '../server/dist-v4/outbox/infrastructure/bullmq-outbox-task-publisher.js'
import { Queue, Worker, QueueEvents } from 'bullmq'
import { parse as parseEnv } from 'dotenv'

const entryEventReference = process.env.AURUM_REFERENCE_ENTRY_EVENT === '1'
const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination ?? ''))
const output = await open(destination, 'wx', 0o600)
const name = 'dev_vue_analysis_ref_' + randomUUID().replaceAll('-', '')
const report = { passed: false, existingDatabaseWrites: 0, syntheticPorts: ['model-result'], omittedTraderContextPorts: [], remainingEvidenceLimits: ['synthetic-market-data-and-model-responses', 'synthetic-terminal-route-and-result', 'synthetic-bridge-command-transport', 'stub-http-authentication', 'empty-reference-inventory', 'review-case-job-and-evidence-seeded-before-worker','analysis-memory-bootstrap', 'resolver-wrapper-uses-injected-fetch'], foreignKeysVerified: false, checks: [] }
let analysisQueue, analysisEvents, analysisWorker, routes, gatewayRoute, gatewayPrefix, db, pool, leaseRedis, leaseKey, queue, riskQueue, executionQueue, riskWorker, executionWorker, executionEvents, riskEvents, queueEvents, worker, created = false
try {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.ok(credentials.host === '127.0.0.1' && credentials.port === 13316 && credentials.user === 'root')
  db = await mysql.createConnection({ ...credentials, database: 'dev_vue', timezone: 'Z' })
  const [[identity]] = await db.query('SELECT @@server_uuid uuid,@@innodb_force_recovery recovery')
  assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104'); assert.equal(Number(identity.recovery), 0)
  const tables = ['strategy_memory_injection_logs_v4', 'ai_model_profiles', 'ai_model_provider_capabilities', 'user_model_defaults', 'ai_model_usage_logs', 'platform_model_usage_policy', 'market_candles', 'observer_channels', 'observer_sources', 'observer_channel_accesses', 'trading_account_ownership_intervals', 'user_trading_account_settings', 'trading_projection_provenance_v4', 'strategy_memory_libraries_v4', 'strategy_memory_library_revisions_v4', 'users', 'ai_analysis_runs', 'ai_model_tasks', 'ai_model_attempts', 'inference_snapshots', 'market_analyses',
    'market_analysis_payloads', 'ai_trader_runs', 'trade_decisions', 'outbox_events', 'strategy_subscriptions',
    'subscription_schedules', 'trading_account_ownerships', 'trading_projection_revisions', 'open_position_snapshots', 'pending_order_snapshots',
    'trading_accounts', 'account_runtime_snapshots', 'market_quotes', 'market_instrument_snapshots', 'account_risk_summaries',
    'subscription_execution_preferences', 'inference_snapshot_payloads', 'trade_decision_payloads', 'strategies', 'strategy_versions',
    'risk_policy_sets_v4', 'risk_policy_versions_v4', 'global_risk_controls', 'account_risk_states', 'risk_manual_releases',
    'risk_decisions_v4', 'risk_decision_payloads_v4', 'operations', 'operation_events', 'execution_intents', 'execution_intent_payloads',
    'execution_intent_events', 'risk_reservations_v4', 'risk_reservation_events_v4', 'terminal_profiles', 'terminal_account_bindings',
    'bridge_connection_sessions', 'bridge_commands_v4', 'bridge_command_payloads_v4', 'bridge_command_events_v4', 'bridge_command_results_v4',
    'execution_outcomes', 'execution_distribution_targets', 'execution_distributions']
  if (entryEventReference) tables.push('inference_entry_event_claims_v4', 'database_upgrade_steps_v4')
  const [reviewTables] = await db.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND (TABLE_NAME LIKE 'review\\_%' OR TABLE_NAME LIKE 'strategy\\_memory\\_%')")
  for (const { name: table } of reviewTables) if (!tables.includes(table)) tables.push(table)
  const definitions = []
  for (const table of tables) {
    const [[row]] = await db.query('SHOW CREATE TABLE `' + table + '`')
    // This transaction probe preserves columns/checks/indexes; FK coverage is separately required.
    definitions.push(row['Create Table'].split('\n').filter(line => !line.includes('FOREIGN KEY')).join('\n').replace(/,\n\)/g, '\n)'))
  }
  await db.query('CREATE DATABASE `' + name + '`'); created = true
  await db.query('USE `' + name + '`')
  await db.query("SET SESSION time_zone='+00:00'")
  for (const ddl of definitions) await db.query(ddl)
  if (entryEventReference) await db.query("INSERT INTO database_upgrade_steps_v4 (id,checksum_sha256,status,started_at_utc,completed_at_utc) SELECT id,checksum_sha256,status,started_at_utc,completed_at_utc FROM dev_vue.database_upgrade_steps_v4 WHERE id='inplace_079_01_entry_event_claims' AND status='completed'")
  const [[memorySchema]] = await db.query("SELECT COUNT(*) n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='strategy_memory_injection_logs_v4' AND COLUMN_NAME IN ('record_version','input_snapshot_id','input_snapshot_sha256','estimated_token_count','token_estimate_method')")
  assert.equal(Number(memorySchema.n), 5)
  report.memorySchemaClonedFromCurrentDatabase = true
  pool = mysql.createPool({ ...credentials, database: name, timezone: 'Z', connectionLimit: 2 })
  const now = new Date(), later = new Date(now.getTime() + 300000)
  const sqlTime = value => value.toISOString().slice(0, 23).replace('T', ' ')
  const insert = async (table, values) => {
    assert.ok(tables.includes(table))
    const [columns] = await db.execute('SELECT COLUMN_NAME name,DATA_TYPE type,COLUMN_TYPE definition,IS_NULLABLE nullable,COLUMN_DEFAULT fallback,EXTRA extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [name, table])
    const row = { ...values }
    for (const col of columns) {
      if (Object.hasOwn(row, col.name) || col.nullable === 'YES' || col.fallback !== null || /auto_increment|GENERATED/.test(col.extra)) continue
      row[col.name] = col.type === 'enum' ? /^enum\('([^']+)'/.exec(col.definition)[1]
        : col.type === 'json' ? '{}' : ['datetime', 'timestamp'].includes(col.type) ? sqlTime(now)
          : /int|decimal|float|double/.test(col.type) ? 1 : col.name.includes('sha256') ? 'a'.repeat(64) : 'fixture'
    }
    const keys = Object.keys(row); assert.ok(keys.every(key => /^[a-z][a-z0-9_]*$/.test(key)))
    await db.execute(`INSERT INTO ${table} (${keys.map(key => '`' + key + '`').join(',')}) VALUES (${keys.map(() => '?').join(',')})`, Object.values(row))
  }
  const unused = () => { throw Error('unexpected_port') }
  await insert('users', { id: 7, deletion_status: 'active', deleted_at: null })
  await insert('trading_account_ownership_intervals', { id: 'ownership_12345678', user_id: 7, trading_account_id: 5, role: 'owner', started_at_utc: sqlTime(new Date(now.getTime()-60000)), ended_at_utc: null })
  await insert('trading_account_ownerships', { user_id: 7, trading_account_id: 5, role: 'owner', interval_id: 'ownership_12345678', granted_at_utc: sqlTime(new Date(now.getTime()-60000)), revoked_at_utc: null })
  await insert('strategy_subscriptions', { id: 9, user_id: 7, trading_account_id: 5, revision: 2, analysis_strategy_id: 1,
    analysis_strategy_version_id: 11, standard_symbol: 'XAUUSD', trader_strategy_id: 2, trader_strategy_version_id: 22,
    status: 'active', analysis_enabled: 1, trader_enabled: 1 })
  await insert('subscription_schedules', { subscription_id: 9, receive_timezone: 'UTC', receive_window_json: JSON.stringify({ enabled: false }) })
  await insert('trading_projection_revisions', { trading_account_id: 5, resource_kind: 'positions', resource_id: 'open', revision: 3 })
  await insert('trading_projection_revisions', { trading_account_id: 5, resource_kind: 'pending_orders', resource_id: 'open', revision: 4 })
  await insert('trading_accounts', { id: 5, platform: 'mt5', currency: 'USD', broker_server: 'Fixture Broker', account_login: '001' })
  await insert('terminal_profiles', { id: 'profile_12345678', user_id: 7, platform: 'mt5' })
  await insert('terminal_account_bindings', { terminal_profile_id: 'profile_12345678', trading_account_id: 5, terminal_instance_id: 'terminal_12345678' })
  await insert('bridge_connection_sessions', { user_id: 7, trading_account_id: 5, terminal_profile_id: 'profile_12345678', terminal_instance_id: 'terminal_12345678', connection_epoch: '3', connection_epoch_v4: 3 })
  for (const [resource, resourceId, revision] of [['account.metrics', 'current', 1], ['market.quote', 'XAUUSD', 1]]) {
    await insert('trading_projection_revisions', { trading_account_id: 5, resource_kind: resource, resource_id: resourceId, revision })
  }
  for (const [resource, resourceId, revision] of [['account.metrics', 'current', 1], ['positions', 'open', 3], ['pending_orders', 'open', 4]]) {
    await insert('trading_projection_provenance_v4', { trading_account_id: 5, resource_kind: resource, resource_id: resourceId, projection_revision: revision,
      user_id: 7, ownership_interval_id: 'ownership_12345678', ownership_revision: 1, terminal_profile_id: 'profile_12345678', terminal_instance_id: 'terminal_12345678', connection_epoch: 3 })
  }
  await insert('account_runtime_snapshots', { trading_account_id: 5, revision: 1, trade_permission: 1, clock_status: 'calibrated', timezone_offset_minutes: 180, observed_at_utc: sqlTime(now) })
  for (const [timeframe, minutes] of [['M5', 5], ['M15', 15], ['H1', 60], ['H4', 240]]) {
    const step = minutes*60000, end = Math.floor(now.getTime()/step)*step
    for (let i=timeframe === 'M5' ? 1800 : 300;i>0;i--) await insert('market_candles', { trading_account_id: 5, symbol: 'XAUUSD', timeframe,
      open_time_utc: sqlTime(new Date(end-i*step)), open_price: '2500', high_price: entryEventReference && timeframe === 'M5' && i <= 2 ? '2505' : '2501', low_price: '2499', close_price: entryEventReference && timeframe === 'M5' && i <= 2 ? String(2505-i) : '2500', tick_volume: '10', closed: 1, revision: 1 })
  }
  await insert('market_quotes', { trading_account_id: 5, symbol: 'XAUUSD', revision: 1, bid: '2500', ask: '2500.10' })
  const instrumentData = { point: '0.01', tick_size: '0.01', tick_value: '1', volume_min: '0.01', volume_max: '100', volume_step: '0.01', tradeEnabled: true,
    sourceEvidence: { userId: 7, ownershipRevision: 1, terminalInstanceId: 'terminal_12345678', terminalProfileId: 'profile_12345678', connectionEpoch: 3 } }
  await insert('market_instrument_snapshots', { trading_account_id: 5, symbol: 'XAUUSD', revision: 1, payload_json: JSON.stringify(instrumentData) })
  await db.execute('UPDATE market_instrument_snapshots SET observed_at_utc=UTC_TIMESTAMP(3) WHERE trading_account_id=5')
  await db.execute('UPDATE bridge_connection_sessions SET last_seen_at_utc=UTC_TIMESTAMP(3) WHERE trading_account_id=5')
  const instruments = createMysqlInstrumentSnapshotReader(pool)
  assert.equal((await instruments.read('5', 'XAUUSD'))?.revision, 1)
  await db.execute('UPDATE bridge_connection_sessions SET connection_epoch_v4=4 WHERE trading_account_id=5')
  assert.equal(await instruments.read('5', 'XAUUSD'), null)
  await db.execute('UPDATE bridge_connection_sessions SET connection_epoch_v4=3 WHERE trading_account_id=5')
  report.checks.push('actual-instrument-reader-requires-current-owner-binding-and-connection-epoch')
  await insert('account_risk_summaries', { trading_account_id: 5, revision: 1 })
  await insert('subscription_execution_preferences', { subscription_id: 9, contract_version: 1, take_profit_mode: 'ai_recommended', revision: 1 })
  await insert('observer_sources', { id: 1, trading_account_id: 5, analysis_strategy_id: 1, operator_user_id: 7, status: 'active', configuration_status: 'ready', revision: 1 })
  await insert('observer_channels', { id: 1, source_id: 1, source_trading_account_id: 5, slug: 'reference-fixture', active: 1, audience: 'all', revision: 1 })
  const clock = () => ({ read: unused }) // Disabled UTC schedule does not read a terminal clock.
  const repository = createMysqlInferenceRepository(pool, clock, createSubscriptionPreferencesReader, createSubscriptionExecutionWindowReader, {
    risks: createAccountRiskSummaryReader, subscribers: createAnalysisSubscriberReader, inventory: createAccountInventorySummaryReader,
  }, createMysqlRuntimeMemoryPreparationWriter)
  await insert('strategies', { id: 1, kind: 'analysis', scope: 'user', owner_user_id: 7, status: 'active', active_version_id: 11 })
  await insert('strategy_versions', { id: 11, strategy_id: 1, version_number: 1, prompt_text: 'Synthetic analysis', prompt_sha256: createHash('sha256').update('Synthetic analysis').digest('hex'), config_json: JSON.stringify({ timeframes: ['M5'], candle_limit: 300, chan_evidence: { version: 1, enabled: true }, ...(entryEventReference ? { price_action_evidence: { version: 1, enabled: true } } : {}) }), input_contract_version: 'market-analysis-input/v1', output_contract_version: 'market-analysis/v1' })
  const strategy = { id: '22', strategyId: '2', kind: 'trader', version: 1, promptText: 'Synthetic trader', promptHash: 'b'.repeat(64),
    config: entryEventReference ? { entry_event_policy: { version: 1, mode: 'required', timeframe: 'M5' } } : {}, inputContractVersion: 'account-trader-input/v1', outputContractVersion: 'trade-decision/v1' }
  strategy.promptHash = createHash('sha256').update(strategy.promptText).digest('hex')
  await insert('strategies', { id: 2, kind: 'trader', scope: 'user', owner_user_id: 7, status: 'active', active_version_id: 22 })
  await insert('strategy_versions', { id: 22, strategy_id: 2, version_number: 1, prompt_text: strategy.promptText, prompt_sha256: strategy.promptHash, config_json: JSON.stringify(strategy.config), input_contract_version: 'account-trader-input/v1', output_contract_version: 'trade-decision/v1' })
  for (const strategyId of [1,2]) {
    const memoryText = 'Synthetic confirmed-memory fixture for strategy ' + strategyId
    await insert('strategy_memory_libraries_v4', { id: 'memory_library_' + strategyId, strategy_id: strategyId, owner_user_id: 7, mode: 'active', status: 'active', current_revision_id: 'memory_revision_' + strategyId, revision: 1, max_context_tokens: 800 })
    await insert('strategy_memory_library_revisions_v4', { id: 'memory_revision_' + strategyId, library_id: 'memory_library_' + strategyId, version_number: 1, content_text: memoryText,
      content_sha256: createHash('sha256').update(memoryText).digest('hex'), source_kind: 'bootstrap', source_metadata_json: '{}', created_by_user_id: 7 })
  }
  const confirmedMemory = await verifyReviewMemoryConfirmation(db, pool, insert)
  report.checks.push(...confirmedMemory.checks)
  const expectedMemoryText = { '1': 'Synthetic confirmed-memory fixture for strategy 1', '2': confirmedMemory.contentText }
  await db.execute('UPDATE strategy_subscriptions SET trade_send_enabled=1 WHERE id=9')
  const platformPolicy = { ...DEFAULT_RISK_POLICY, tradeSendEnabled: true }
  await insert('risk_policy_sets_v4', { id: 1, scope: 'platform', status: 'active', active_version_id: 1, revision: 1 })
  await insert('risk_policy_versions_v4', { id: 1, policy_set_id: 1, policy_json: JSON.stringify(platformPolicy) })
  await insert('risk_policy_sets_v4', { id: 2, scope: 'account', owner_user_id: 7, trading_account_id: 5, status: 'active', active_version_id: 2, revision: 1 })
  await insert('risk_policy_versions_v4', { id: 2, policy_set_id: 2, policy_json: JSON.stringify({ tradeSendEnabled: true }) })
  await insert('global_risk_controls', { id: 1, kill_switch: 0, revision: 1 })
  await insert('account_risk_states', { trading_account_id: 5, revision: 1 })
  const summary = { accountId: '5', userId: 7, businessDate: now.toISOString().slice(0, 10), equity: '10000', freeMargin: '10000',
    marginLevelPercent: 5000, dailyLossPercent: 0, drawdownPercent: 0, openPositions: 0, pendingOrders: 0, totalVolume: '0', dailyOpenCount: 0,
    consecutiveLosses: 0, lastSuccessfulOpenAt: null, cooldownUntil: null, terminalTimezoneOffsetMinutes: 180, clockStatus: 'calibrated',
    dataComplete: true, incompleteReasons: [], observedAt: now.toISOString(), revision: 1 }
  await db.execute('UPDATE account_risk_summaries SET payload_json=? WHERE trading_account_id=5', [JSON.stringify(summary)])
  const riskProcessor = createRiskReviewWorker(pool, createMysqlTradeDecisionRiskWriter,
    instruments,
    undefined, { evidence: createDecisionStrategyEvidenceReader, config: createStrategyExecutionConfigReader, createMysqlStrategyService })
  const execution = new ExecutionService(new MysqlExecutionRepository(pool, clock, createTransactionRiskDecisionExecutionWriter, createStrategyExecutionConfigReader))
  const strategies = createMysqlStrategyService(pool)
  const env = parseEnv(await readFile(new URL('../server/.env', import.meta.url)))
  assert.equal(env.REDIS_HOST, '192.168.1.254')
  const connection = { host: env.REDIS_HOST, port: Number(env.REDIS_PORT || 6379), db: Number(env.REDIS_DB || 0),
    password: env.REDIS_PASSWORD || undefined, maxRetriesPerRequest: null, connectTimeout: 5000 }
  const prefix = 'analysis-reference-' + randomUUID(), queueName = 'aurum-v4-trader'
  leaseRedis = new Redis(connection)
  gatewayPrefix = prefix + ':gateway'
  routes = new RedisBridgeGatewayLeaseStore(leaseRedis, gatewayPrefix)
  gatewayRoute = { userId: 7, accountId: '5', platform: 'mt5', brokerServer: 'Fixture Broker', login: '001',
    terminalProfileId: 'profile_12345678', terminalInstanceId: 'terminal_12345678', connectionEpoch: 3,
    ownershipRevision: '1', connectionId: 'connection_12345678', sessionId: 'session_12345678', timezoneOffsetMinutes: 180 }
  await routes.claim({ route: gatewayRoute, capacity: 1, ttlSeconds: 120 })
  await db.execute("UPDATE bridge_connection_sessions SET connection_epoch='v4:connection_12345678',last_seen_at_utc=UTC_TIMESTAMP(3) WHERE trading_account_id=5")
  const contexts = createMysqlTraderContext(pool, repository, createTradingReader(pool, routes, createAccountPrincipalReader),
    createSubscriptionPreferencesReader, instruments, createMysqlInstrumentCollectionRequester(pool),
    createAccountRiskSummaryReader(pool), createMysqlRuntimeStrategyMemoryReader(pool), createStrategyReferencePortfolioReader(pool, routes))
  let modelCalls = 0
  const usageLedger = createMysqlModelUsageLedger(pool, { principals: createAccountPrincipalReader, active: createActivePrincipalAccess })
  const credentialKey = randomBytes(32), credentialIv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', credentialKey, credentialIv)
  const credentialCiphertext = Buffer.concat([cipher.update('synthetic-only', 'utf8'), cipher.final()])
  const encryptedCredential = JSON.stringify({ v: 'fixture', iv: credentialIv.toString('base64'), ct: credentialCiphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') })
  await insert('ai_model_profiles', { id: 1, owner_user_id: 7, scope: 'user', provider: 'custom', model_name: 'fixture', api_base_url: 'http://127.0.0.1:9/v1', api_key_encrypted: encryptedCredential,
    temperature: '0', max_tokens: 2000, request_timeout_ms: 60000, status: 'active' })
  await insert('ai_model_provider_capabilities', { model_profile_id: 1, provider: 'custom', model_name: 'fixture', api_base_url: 'http://127.0.0.1:9/v1', protocol: 'chat_completions', verification_status: 'verified', supports_structured_output: 0 })
  await insert('user_model_defaults', { user_id: 7, model_profile_id: 1 })
  const profiles = new MysqlRuntimeModelProfileCatalog(pool, new Map([['fixture', credentialKey]]),
    { allowPrivateEndpoints: true, maxAttempts: 1, defaultTimeoutMs: 60000 }, createRuntimeStrategyAccess(pool), createAccountPrincipalReader(pool))
  const profileScope = { userId: 7, strategyId: '1', strategyVersionId: '11', usage: 'auto' }
  assert.equal((await profiles.resolve(profileScope)).apiKey === 'synthetic-only', true)
  await db.execute("UPDATE ai_model_provider_capabilities SET model_name='different' WHERE model_profile_id=1")
  await assert.rejects(profiles.resolve(profileScope), { code: 'model_profile_not_verified' })
  await db.execute("UPDATE ai_model_provider_capabilities SET model_name='fixture' WHERE model_profile_id=1")
  await db.execute('UPDATE ai_model_profiles SET owner_user_id=8 WHERE id=1')
  await assert.rejects(profiles.resolve(profileScope), { code: 'model_profile_unavailable' })
  await db.execute('UPDATE ai_model_profiles SET owner_user_id=7 WHERE id=1')
  report.checks.push('actual-model-catalog-decrypts-synthetic-credential-and-rejects-capability-or-owner-mismatch')
  const withUsageGateway = (kind, source) => ({ async resolve(scope) {
    const profile = await profiles.resolve({ ...scope, usage: kind === 'analysis' && scope.trigger === 'manual' ? 'manual' : 'auto' })
    const request = async (_url, init) => {
      const [[reserved]] = await db.query("SELECT COUNT(*) n FROM ai_model_usage_logs WHERE request_status='reserved'")
      assert.equal(Number(reserved.n), 1)
      const body = JSON.parse(init.body)
      const snapshot = JSON.parse(body.messages.at(-1).content)
      const output = await source[kind === 'analysis' ? 'analyze' : 'decide']({ snapshot, signal: init.signal })
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output.result) } }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }), { status: 200 })
    }
    return kind === 'analysis' ? new HttpJsonAnalysisModelGateway(profile, usageLedger, request) : new HttpJsonTraderModelGateway(profile, usageLedger, request)
  } })
  const processor = new TraderWorker(repository, new InferenceService(repository, strategies), strategies, contexts,
    withUsageGateway('trader', { profileId: null, provider: 'fixture', model: 'fixture', timeoutMs: 60000, maxAttempts: 1, async decide({ snapshot }) {
      modelCalls++
      assert.equal(snapshot.account.id, '5')
      assert.equal(snapshot.account.bridgeState, 'online')
      assert.equal(snapshot.account.tradePermission, true)
      assert.equal(snapshot.contract.point, '0.01')
      assert.equal(snapshot.strategyMemory.state, 'ready')
      assert.equal(snapshot.strategyMemory.contentText, expectedMemoryText[snapshot.strategy.id])
      assert.equal(snapshot.strategyReferencePortfolio.state, 'ready')
      assert.equal(snapshot.strategyReferencePortfolio.sourceAccountId, '5')
      assert.deepEqual(snapshot.strategyReferencePortfolio.positions, [])
      assert.deepEqual(snapshot.strategyReferencePortfolio.pendingOrders, [])
      report.checks.push('actual-reference-portfolio-freezes-authorized-analysis-source-and-confirmed-empty-inventory')
      assert.deepEqual(snapshot.positions, [])
      assert.deepEqual(snapshot.pendingOrders, [])
      report.checks.push('actual-trader-context-freezes-account-provenance-instrument-preferences-and-memory-state')
      const expectedState = Object.fromEntries(['analysisRevision', 'subscriptionRevision', 'accountRevision', 'positionsRevision',
        'pendingOrdersRevision', 'quoteRevision', 'contractRevision', 'riskRevision'].map(key => [key, snapshot[key]]))
      const event = entryEventReference ? snapshot.marketEntryEvents?.timeframes?.M5?.events?.find(item => item.direction === 'up' && item.stillValid) : null
      if (entryEventReference) {
        assert.ok(event); assert.equal(snapshot.entryEventUsage.state, 'read')
        assert.equal(snapshot.entryEventUsage.items.find(item => item.eventId === event.id)?.state, 'available')
        assert.equal(snapshot.entryEventPolicy.mode, 'required')
        report.entryEventId = event.id
      }
      return { result: { action: 'market_order', side: 'buy', confidence: 70, summary: 'Synthetic entry', reasoning: 'Test fixture',
        actions: [{ actionId: 'entry-1', kind: 'market_order', parameters: { ...(event ? { entry_event_id: event.id } : {}), symbol: 'XAUUSD', side: 'buy', volume: '0.01', reference_price: '2500.10', stop_loss: '2490', recommended_take_profit_tier: 1, take_profit_prices: ['2510', '2520', '2530'] }, expectedState }] }, usage: null }
    } }), 'reference-trader', createMysqlTraderWindowGuard(pool, clock, createSubscriptionExecutionWindowReader))
  queue = new Queue(queueName, { connection, prefix })
  riskQueue = new Queue('aurum-v4-risk', { connection, prefix })
  executionQueue = new Queue('aurum-v4-execution', { connection, prefix })
  executionEvents = new QueueEvents('aurum-v4-execution', { connection, prefix }); await executionEvents.waitUntilReady()
  leaseKey = prefix + ':account:5'
  const commandRepository = new MysqlBridgeCommandRepository(pool, clock, createTransactionRiskPolicyReader,
    undefined, undefined, undefined, undefined, createStrategyExecutionConfigReader)
  const commands = new BridgeCommandService(commandRepository)
  const preparation = new ExecutionPreparationWorker(new MysqlExecutionCommandSource(pool, { magic: 4000, deviation: 10 }),
    new RedisAccountExecutionLeaseStore(leaseRedis, prefix + ':account'), commands)
  const executionProcessor = createExecutionProcessor({ planning: execution, preparation, distributionTargets: { run: unused } })
  executionWorker = new Worker('aurum-v4-execution', executionProcessor, { connection, prefix })
  await executionWorker.waitUntilReady()
  riskEvents = new QueueEvents('aurum-v4-risk', { connection, prefix }); await riskEvents.waitUntilReady()
  riskWorker = new Worker('aurum-v4-risk', async job => {
    assert.equal(job.name, 'risk.review')
    const result = await riskProcessor.process(job.data.decisionId)
    report.riskResult = { status: result.status, code: result.code, rejectCode: result.decision?.rejectCode }
    assert.ok(['approved', 'rejected'].includes(result.status))
    if (result.status === 'rejected') assert.equal(result.decision.rejectCode, 'RISK_WEEKEND_PROTECTION')
    return { riskDecisionId: result.decision.id, status: result.status }
  }, { connection, prefix })
  await riskWorker.waitUntilReady()
  queueEvents = new QueueEvents(queueName, { connection, prefix })
  await queueEvents.waitUntilReady()
  let deliveries = 0
  worker = new Worker(queueName, async job => {
    assert.equal(job.name, 'trader.run')
    const run = await repository.getTraderRun(job.data.traderRunId)
    assert.ok(run); assert.equal(run.status, 'queued'); assert.equal(run.userId, 7)
    deliveries++
    const result = await processor.process(run.id)
    report.traderResult = { status: result.status, code: result.code }
    assert.equal(result.status, 'succeeded', JSON.stringify(result))
    assert.equal(result.decision.action, 'market_order')
    assert.equal(result.decision.status, 'proposed')
    return { traderRunId: run.id, analysisId: run.marketAnalysisId }
  }, { connection, prefix })
  worker.on('failed', (_job, error) => {
    report.workerError = error.code ?? (/^[a-z0-9_]{3,128}$/.test(error.message) ? error.message : error.name)
    report.workerLocations = String(error.stack).split('\n').filter(line => /^\s+at /.test(line)).slice(0, 3)
  })
  await worker.waitUntilReady()
  await db.execute('UPDATE trading_projection_provenance_v4 SET observed_at_utc=? WHERE trading_account_id=5', [sqlTime(new Date(Date.now()-1000))])
  let revokeDuringAnalysis = false, analysisModelCalls = 0
  const analysisTrading = createTradingReader(pool, routes, createAccountPrincipalReader)
  const analysisProcessor = new AnalysisWorker(repository, new InferenceService(repository, strategies), strategies,
    new AnalysisContextBuilder(createAnalysisMarketSource(analysisTrading), createMysqlMacroSnapshotReader(pool), createMysqlRuntimeStrategyMemoryReader(pool)),
    withUsageGateway('analysis', { profileId: null, provider: 'fixture', model: 'fixture', timeoutMs: 60000, maxAttempts: 1, async analyze({ snapshot }) {
      analysisModelCalls++
      assert.equal(snapshot.market.source_account_id, '5')
      assert.equal(snapshot.market.candles.M5.length, 300)
      assert.equal(Object.hasOwn(snapshot.market,'calculation_archive'),false)
      const chan = snapshot.market.indicators.chan.M5
      assert.equal(chan.algorithm_version, 'chan_structure_v8')
      assert.equal(chan.requested_bars, 1800)
      assert.equal(chan.received_bars, 1800)
      assert.equal(chan.structure.evidence_capabilities.data_complete, true)
      assert.equal(chan.structure.evidence_capabilities.entry_structure_usable, false)
      assert.equal(JSON.stringify(chan).includes('_confirmed_segments'), false)
      report.chanWorkerInputVerified = true
      assert.equal(snapshot.strategyMemory.state, 'ready')
      assert.equal(snapshot.strategyMemory.contentText, expectedMemoryText[snapshot.strategy.id])
      if (revokeDuringAnalysis) await db.execute('UPDATE trading_account_ownerships SET revoked_at_utc=? WHERE user_id=7 AND trading_account_id=5', [sqlTime(now)])
      return { result: { marketBias: 'bullish', opportunity: 'long_setup', confidence: 70, summary: 'fixture', marketRegime: 'trend', analysisBody: 'Synthetic analysis', supportingEvidence: [], counterEvidence: [], dataGaps: [], keyLevels: {}, invalidation: {}, analyzedAt: now.toISOString(), validUntil: later.toISOString() }, usage: null }
    } }), 'reference-analysis', createAnalysisWindowGuard(createAnalysisWindowReader(pool), (id,user) => analysisTrading.getAccountSnapshot(id,user)))
  analysisQueue = new Queue('aurum-v4-analysis', { connection, prefix })
  analysisEvents = new QueueEvents('aurum-v4-analysis', { connection, prefix }); await analysisEvents.waitUntilReady()
  analysisWorker = new Worker('aurum-v4-analysis', async job => {
    assert.equal(job.name, 'analysis.run')
    try { return await analysisProcessor.process(job.data.analysisId) }
    catch (error) { report.analysisSqlMissingField = /Unknown column '([a-zA-Z0-9_.]+)'/.exec(error.sqlMessage ?? '')?.[1]; report.analysisWorkerError = error.code ?? (/^[a-z0-9_]{3,128}$/.test(error.message) ? error.message : error.name); throw error }
  }, { connection, prefix }); await analysisWorker.waitUntilReady()
  for (const suffix of ['success', 'revoked']) {
    const scheduleNow = new Date(now.getTime() + (suffix === 'revoked' ? 60000 : 0))
    await db.execute('UPDATE subscription_schedules SET cadence_seconds=60,next_due_at_utc=? WHERE subscription_id=9', [sqlTime(scheduleNow)])
    const inference = new InferenceService(repository, strategies)
    const scheduleStore = createMysqlAnalysisScheduleStore(pool)
    const scheduler = createAnalysisScheduler(scheduleStore, inference,
      (accountId, userId) => createTradingReader(pool, undefined, createAccountPrincipalReader).getAccountSnapshot(accountId, userId))
    const scheduled = await scheduler.tick(scheduleNow)
    report.scheduleFailures = scheduled.failures.map(item => ({ code: item.error?.code ?? item.error?.message }))
    assert.equal(scheduled.failures.length, 0)
    assert.equal(scheduled.runs.length, 1)
    assert.equal((await scheduler.tick(scheduleNow)).runs.length, 0)
    const scheduledRun = scheduled.runs[0]
    const runId = scheduledRun.id
    await db.execute('UPDATE subscription_schedules SET next_due_at_utc=? WHERE subscription_id=9', [sqlTime(scheduleNow)])
    const replayedSchedule = await scheduler.tick(scheduleNow)
    assert.equal(replayedSchedule.failures.length, 0)
    assert.equal(replayedSchedule.runs[0]?.id, runId)
    const [[queuedEvidence]] = await db.execute("SELECT COUNT(*) n FROM outbox_events WHERE event_type='analysis.requested' AND aggregate_id=?", [runId])
    assert.equal(Number(queuedEvidence.n), 1)
    const [[storedTimes]] = await db.execute('SELECT schedule_slot_utc,created_at_utc FROM ai_analysis_runs WHERE id=?', [runId])
    assert.equal(storedTimes.created_at_utc.toISOString(), scheduleNow.toISOString())
    assert.equal(storedTimes.schedule_slot_utc.toISOString(), new Date(Math.floor(scheduleNow.getTime()/60000)*60000).toISOString())
    report.checks.push('scheduler-replay-keeps-one-run-one-outbox-and-exact-UTC-milliseconds')
    revokeDuringAnalysis = suffix === 'revoked'
    const analysisOutbox = new MysqlOutboxRepository(pool)
    const [[analysisClock]] = await db.query('SELECT UTC_TIMESTAMP(3) now_utc')
    const analysisEvent = (await analysisOutbox.claim('reference-analysis-dispatch',20,30,analysisClock.now_utc)).find(item => item.eventType === 'analysis.requested' && item.payload.analysis_id === runId)
    assert.ok(analysisEvent)
    await new BullMqOutboxTaskPublisher({ analysis: analysisQueue }).publish(analysisEvent)
    const analysisJob = await analysisQueue.getJob(analysisEvent.eventId); assert.ok(analysisJob)
    const completed = await analysisJob.waitUntilFinished(analysisEvents, 15000)
    report.analysisResult = { status: completed.status, code: completed.code }
    assert.equal(completed.status, 'succeeded')
    await analysisOutbox.markDispatched(analysisEvent.id, 'reference-analysis-dispatch', new Date())
    assert.equal((await analysisProcessor.process(runId)).status, 'ignored')
    assert.equal(analysisModelCalls, suffix === 'revoked' ? 2 : 1)
    const result = completed
    const input = { runId, userId: 7, expectedRevision: 2, marketAnalysisId: completed.analysis.id }
    report.checks.push('actual-analysis-outbox-queue-worker-and-context-complete-once')
    if (suffix === 'revoked') {
      assert.equal(result.traderRuns.length, 0)
      const [[count]] = await db.execute('SELECT COUNT(*) n FROM ai_trader_runs WHERE market_analysis_id=?', [input.marketAnalysisId])
      assert.equal(Number(count.n), 0)
      report.checks.push('real-revoked-ownership-excludes-trader-fanout')
    } else {
      assert.equal(result.analysis.id, input.marketAnalysisId); assert.equal(result.traderRuns.length, 1)
      assert.equal(result.analysis.analyzedAt, now.toISOString()); assert.equal(result.analysis.validUntil, later.toISOString())
      const [[eventCount]] = await db.execute("SELECT COUNT(*) n FROM outbox_events WHERE event_type='trader.requested' AND aggregate_id=?", [result.traderRuns[0].id])
      assert.equal(Number(eventCount.n), 1)
      await assert.rejects(repository.completeAnalysis(input), { code: 'analysis_revision_conflict' })
      report.checks.push('analysis-result-and-trader-task-commit-with-UTC-and-outbox', 'duplicate-completion-rejected')
      const contextRun = await repository.getTraderRun(result.traderRuns[0].id)
      const contextStrategy = await strategies.requireActiveVersion(7, '2', 'trader')
      assert.ok(contextRun && contextStrategy)
      await db.execute('UPDATE observer_channels SET active=0 WHERE id=1')
      await assert.rejects(contexts.build(contextRun, contextStrategy), { code: 'strategy_reference_inventory_unavailable' })
      await db.execute('UPDATE observer_channels SET active=1 WHERE id=1')
      const restoredContext = await contexts.build(contextRun, contextStrategy)
      assert.equal(restoredContext.strategyReferencePortfolio.state, 'ready')
      report.checks.push('disabled-reference-channel-rejects-context-before-model-and-restoration-recovers')
      const outbox = new MysqlOutboxRepository(pool)
      const [[databaseClock]] = await db.query('SELECT UTC_TIMESTAMP(3) now_utc')
      const events = await outbox.claim('reference-dispatcher', 20, 30, databaseClock.now_utc)
      const event = events.find(item => item.eventType === 'trader.requested')
      assert.ok(event)
      const publisher = new BullMqOutboxTaskPublisher({ trader: queue })
      await publisher.publish(event)
      const job = await queue.getJob(event.eventId); assert.ok(job)
      assert.deepEqual(await job.waitUntilFinished(queueEvents, 10000), { traderRunId: result.traderRuns[0].id, analysisId: input.marketAnalysisId })
      // Simulate publication succeeding while the SQL acknowledgement was lost.
      await publisher.publish(event)
      assert.equal(await queue.getCompletedCount(), 1); assert.equal(deliveries, 1)
      assert.equal(await outbox.markDispatched(event.id, 'reference-dispatcher', new Date()), true)
      assert.equal(await outbox.markDispatched(event.id, 'reference-dispatcher', new Date()), false)
      report.checks.push('real-outbox-to-BullMQ-consumer-preserves-run-and-analysis-identity', 'replayed-publication-does-not-deliver-a-second-job')
      assert.equal(modelCalls, 1)
      assert.deepEqual(await processor.process(result.traderRuns[0].id), { status: 'ignored' })
      assert.equal(modelCalls, 1)
      const completedRun = await repository.getTraderRun(result.traderRuns[0].id)
      assert.equal(completedRun.status, 'succeeded'); assert.ok(completedRun.decisionId)
      const [[riskClock]] = await db.query('SELECT UTC_TIMESTAMP(3) now_utc')
      const decisionEvents = await outbox.claim('reference-risk-dispatcher', 20, 30, riskClock.now_utc)
      const decisionEvent = decisionEvents.find(item => item.eventType === 'trade_decision.created')
      assert.ok(decisionEvent); assert.equal(decisionEvent.payload.decision_id, completedRun.decisionId)
      await new BullMqOutboxTaskPublisher({ risk: riskQueue }).publish(decisionEvent)
      const riskJob = await riskQueue.getJob(decisionEvent.eventId)
      assert.ok(riskJob); assert.equal(riskJob.name, 'risk.review'); assert.equal(riskJob.data.decisionId, completedRun.decisionId)
      report.checks.push('real-TraderWorker-commits-nonempty-decision-once', 'persisted-decision-published-to-real-risk-queue')
      const riskResult = await riskJob.waitUntilFinished(riskEvents, 10000)
      assert.deepEqual(await riskProcessor.process(completedRun.decisionId), { status: 'ignored' })
      if (entryEventReference) {
        const [claims] = await db.execute('SELECT event_id,state,active_event_id,risk_decision_id FROM inference_entry_event_claims_v4 WHERE decision_id=?', [completedRun.decisionId])
        assert.equal(claims.length, 1); assert.equal(claims[0].event_id, report.entryEventId)
        assert.equal(claims[0].risk_decision_id, riskResult.riskDecisionId)
        assert.equal(claims[0].state, riskResult.status === 'rejected' ? 'released' : 'consumed')
        assert.equal(claims[0].active_event_id, riskResult.status === 'rejected' ? null : report.entryEventId)
        report.entryEventWorkerLifecycleVerified = true
      }
      const [[executionClock]] = await db.query('SELECT UTC_TIMESTAMP(3) now_utc')
      const riskOutbox = await outbox.claim('reference-execution-dispatcher', 20, 30, executionClock.now_utc)
      const approved = riskOutbox.find(item => item.eventType === 'risk.decision.created')
      assert.ok(approved); assert.equal(approved.payload.risk_decision_id, riskResult.riskDecisionId)
      assert.equal(approved.payload.status, riskResult.status)
      if (riskResult.status === 'rejected') {
        assert.equal(approved.payload.reject_code, 'RISK_WEEKEND_PROTECTION')
        const [[recorded]] = await db.execute('SELECT decision_status,reject_code FROM risk_decisions_v4 WHERE id=?', [riskResult.riskDecisionId])
        assert.equal(recorded.decision_status, 'rejected')
        assert.equal(recorded.reject_code, 'RISK_WEEKEND_PROTECTION')
        const [[intents]] = await db.execute('SELECT COUNT(*) n FROM execution_intents WHERE risk_decision_id=?', [riskResult.riskDecisionId])
        assert.equal(Number(intents.n), 0)
        report.executionBranch = 'weekend-rejected-before-execution'
        report.remainingEvidenceLimits.push('execution-approval-branch-not-exercised-during-weekend')
        report.checks.push('weekend-risk-rejection-persists-once-with-no-execution-intents')
      } else {
      report.executionBranch = 'approved-and-synthetic-terminal-result'
      await new BullMqOutboxTaskPublisher({ execution: executionQueue }).publish(approved)
      const executionJob = await executionQueue.getJob(approved.eventId)
      assert.equal(executionJob.name, 'execution.risk-decision.prepare')
      assert.equal(executionJob.data.riskDecisionId, riskResult.riskDecisionId)
      report.checks.push('real-risk-worker-approves-once-with-frozen-strategy-evidence', 'approved-risk-event-reaches-execution-queue')
      assert.deepEqual(await executionJob.waitUntilFinished(executionEvents, 10000), { riskDecisionId: riskResult.riskDecisionId, kind: 'prepared' })
      const prepared = await execution.prepare(executionJob.data.userId, executionJob.data.riskDecisionId)
      assert.equal(prepared.kind, 'prepared'); assert.equal(prepared.intents.length, 1); assert.equal(prepared.reservations.length, 1)
      const repeated = await execution.prepare(executionJob.data.userId, executionJob.data.riskDecisionId)
      assert.equal(repeated.operation.id, prepared.operation.id)
      assert.equal(repeated.intents[0].id, prepared.intents[0].id)
      const [[intentCount]] = await db.execute('SELECT COUNT(*) n FROM execution_intents WHERE risk_decision_id=?', [riskResult.riskDecisionId])
      assert.equal(Number(intentCount.n), 1)
      report.checks.push('real-execution-preparation-persists-one-intent-reservation-and-operation', 'execution-preparation-replay-preserves-original-identity')
      const [[intentClock]] = await db.query('SELECT UTC_TIMESTAMP(3) now_utc')
      const intentEvents = await outbox.claim('reference-intent-dispatcher', 20, 30, intentClock.now_utc)
      const intentEvent = intentEvents.find(item => item.eventType === 'execution.intent.prepared')
      assert.ok(intentEvent); assert.equal(intentEvent.payload.intent_id, prepared.intents[0].id)
      const competingLease = new RedisAccountExecutionLeaseStore(leaseRedis, prefix + ':account')
      assert.equal(await competingLease.acquire('5', 'other-worker', 15), true)
      try {
        assert.equal((await preparation.run(prepared.intents[0].id)).kind, 'busy')
        assert.equal(await commands.findByIntent(prepared.intents[0].id), null)
        await competingLease.release('5', 'wrong-worker')
        assert.equal(await leaseRedis.get(leaseKey), 'other-worker')
      } finally { await competingLease.release('5', 'other-worker') }
      await new BullMqOutboxTaskPublisher({ execution: executionQueue }).publish(intentEvent)
      const intentJob = await executionQueue.getJob(intentEvent.eventId); assert.ok(intentJob)
      const commandResult = await intentJob.waitUntilFinished(executionEvents, 10000)
      assert.equal(commandResult.kind, 'queued')
      const command = await commands.findByIntent(prepared.intents[0].id)
      assert.ok(command); assert.equal(command.id, commandResult.commandId)
      const replayCommand = await preparation.run(prepared.intents[0].id)
      assert.equal(replayCommand.kind, 'existing'); assert.equal(replayCommand.command.id, command.id)
      assert.equal(await leaseRedis.exists(leaseKey), 0)
      report.checks.push('production-intent-consumer-creates-command-and-releases-isolated-account-lease')
      report.checks.push('competing-account-lease-blocks-command-without-releasing-another-owner')
      let socketSends = 0
      const dispatchProcessor = createBridgeCommandProcessor(commands, {
        currentRoute: async () => command.route,
        send: async (request, accountId) => {
          assert.equal(accountId, command.accountId)
          assert.deepEqual(request, command.request)
          assert.equal((await commandRepository.get(command.id)).status, 'dispatched')
          socketSends++
        },
      })
      const dispatchJob = { name: 'bridge.command.dispatch', data: { commandId: command.id } }
      assert.deepEqual(await dispatchProcessor(dispatchJob), { commandId: command.id, status: 'dispatched', dispatched: true })
      assert.deepEqual(await dispatchProcessor(dispatchJob), { commandId: command.id, status: 'dispatched', dispatched: false })
      assert.equal(socketSends, 1)
      report.checks.push('production-bridge-command-processor-persists-before-send-and-replay-does-not-send-again')
      const completedMs = Date.now()
      const envelope = { v: 4, message_id: randomUUID(), type: 'command.result', sent_at_utc_msc: completedMs,
        correlation_id: command.id, route: command.request.route, payload: { command_id: command.id, action: 'order.place', status: 'succeeded',
          completed_at_utc_msc: completedMs, result: { order_ticket: '9100', deal_ticket: '9101' }, error_code: null, terminal_code: null } }
      await assert.rejects(commands.result(envelope, new Date(), { userId: 8, terminalProfileId: 'profile_12345678' }), { code: 'bridge_command_scope_mismatch' })
      const saved = await commands.result(envelope, new Date(), { userId: 7, terminalProfileId: 'profile_12345678' })
      assert.equal(saved.disposition, 'persisted'); assert.equal(saved.acknowledgement.type, 'command.result_ack')
      assert.equal((await commands.result(envelope, new Date(), { userId: 7, terminalProfileId: 'profile_12345678' })).disposition, 'duplicate')
      const [[outcome]] = await db.execute('SELECT status FROM execution_outcomes WHERE execution_intent_id=?', [prepared.intents[0].id])
      assert.equal(outcome.status, 'succeeded')
      assert.equal((await execution.operation(7, prepared.operation.id)).status, 'succeeded')
      const app = Fastify({ logger: false })
      let requestUser = 7
      try {
        await app.register(createExecutionHttp(execution, undefined, undefined, { authenticate: async () => ({ userId: requestUser }) }))
        const response = await app.inject({ method: 'GET', url: '/api/v4/operations/' + prepared.operation.id })
        report.operationHttp = { status: response.statusCode, code: response.json().code }
        assert.equal(response.statusCode, 200); assert.equal(response.json().data.status, 'succeeded')
        assert.equal(response.json().data.operation_id, prepared.operation.id)
        requestUser = 8
        const denied = await app.inject({ method: 'GET', url: '/api/v4/operations/' + prepared.operation.id })
        assert.equal(denied.statusCode, 404)
      } finally { await app.close() }
      report.checks.push('same-intent-creates-one-command-and-persists-simulated-result-before-ack', 'duplicate-result-and-wrong-user-do-not-repeat-effects',
        'actual-operation-HTTP-contract-returns-success-and-denies-another-user')
      }
    }
  }
  const [memoryAudit] = await db.query('SELECT runtime_kind,input_snapshot_id,input_snapshot_sha256,library_revision_id,estimated_token_count FROM strategy_memory_injection_logs_v4 ORDER BY id')
  assert.equal(memoryAudit.length, 3)
  assert.deepEqual(memoryAudit.map(row => row.runtime_kind).sort(), ['analysis','analysis','trader'])
  for (const row of memoryAudit) {
    const [[snapshot]] = await db.execute('SELECT s.payload_sha256,p.payload_json FROM inference_snapshots s INNER JOIN inference_snapshot_payloads p ON p.snapshot_id=s.id WHERE s.id=?', [row.input_snapshot_id])
    const body = typeof snapshot.payload_json === 'string' ? JSON.parse(snapshot.payload_json) : snapshot.payload_json
    assert.equal(row.input_snapshot_sha256, snapshot.payload_sha256)
    assert.equal(row.library_revision_id, body.strategyMemory.revisionId)
    assert.equal(Number(row.estimated_token_count), Math.ceil(Buffer.byteLength(body.strategyMemory.contentText)/4))
    if (row.runtime_kind === 'analysis') {
      const archive=body.market.calculation_archive.M5
      assert.equal(archive.input.candles.length,1800)
      assert.deepEqual(replayChanCalculation(archive),body.market.indicators.chan.M5)
      const modified=structuredClone(archive);modified.input.candles[0].close='1'
      assert.throws(()=>replayChanCalculation(modified),/chan_archive_input_invalid/)
      report.chanDurableArchiveReplayVerified=true
    }
  }
  report.checks.push('nonempty-memory-frozen-input-and-preparation-audit-share-identical-revision-and-hash')
  const [usageRows] = await db.query('SELECT id,request_status,accounting_status,token_count,input_tokens,output_tokens FROM ai_model_usage_logs ORDER BY id')
  assert.equal(usageRows.length, 3)
  for (const row of usageRows) {
    assert.equal(row.request_status, 'success'); assert.equal(row.accounting_status, 'settled')
    assert.equal(Number(row.token_count), 30); assert.equal(Number(row.input_tokens), 20); assert.equal(Number(row.output_tokens), 10)
  }
  await assert.rejects(usageLedger.finish(String(usageRows[0].id), { status: 'success', usage: { total_tokens: 999 }, requestBytes: 1, responseBytes: 1, durationMs: 1 }), /model_usage_reservation_not_pending/)
  const [[unchanged]] = await db.execute('SELECT token_count FROM ai_model_usage_logs WHERE id=?', [usageRows[0].id])
  assert.equal(Number(unchanged.token_count), 30)
  report.checks.push('actual-model-gateways-reserve-before-transport-and-settle-three-calls-once')
  await db.execute("UPDATE users SET plan='pro',plan_expires_at=NULL WHERE id=7")
  await insert('platform_model_usage_policy', { id: 1, share_for_manual: 1, share_for_auto: 1, allowed_plans: JSON.stringify(['pro']), daily_requests_per_user: 1, daily_tokens_per_user: 1000 })
  const sharedScope = { userId: 7, profileId: '1', strategyId: '1', credentialSource: 'platform_shared', usage: 'auto' }
  const reserved = await Promise.allSettled([usageLedger.begin(sharedScope), usageLedger.begin(sharedScope)])
  assert.equal(reserved.filter(item => item.status === 'fulfilled').length, 1)
  assert.deepEqual(reserved.filter(item => item.status === 'rejected').map(item => item.reason.code), ['daily_request_limit'])
  const abandonedId = reserved.find(item => item.status === 'fulfilled').value
  await db.execute('UPDATE ai_model_usage_logs SET created_at=? WHERE id=?', [sqlTime(new Date(now.getTime()-3600000)), abandonedId])
  assert.equal(await usageLedger.recoverAbandoned(new Date(now.getTime()-600000), 1), 1)
  assert.equal(await usageLedger.recoverAbandoned(new Date(now.getTime()-600000), 1), 0)
  const [[recoveredUsage]] = await db.execute('SELECT request_status,error_code,accounting_status FROM ai_model_usage_logs WHERE id=?', [abandonedId])
  assert.equal(recoveredUsage.request_status, 'error')
  assert.equal(recoveredUsage.error_code, 'model_usage_reservation_abandoned')
  assert.equal(recoveredUsage.accounting_status, 'usage_unknown')
  await assert.rejects(usageLedger.finish(abandonedId, { status: 'success', usage: { total_tokens: 999 }, requestBytes: 1, responseBytes: 1, durationMs: 1 }), /model_usage_reservation_not_pending/)
  report.checks.push('actual-shared-quota-concurrency-and-bounded-abandoned-recovery-preserve-unknown-usage')
  report.passed = true
} catch (error) {
  report.errorCode = error?.code ?? error?.name
  report.locations = String(error?.stack ?? '').split('\n').filter(line => /^\s+at /.test(line)).slice(0, 3)
  report.actual = typeof error?.actual === 'string' ? error.actual : undefined
  report.expected = typeof error?.expected === 'string' ? error.expected : undefined
  process.exitCode = 1
} finally {
  if (analysisWorker) await analysisWorker.close()
  if (analysisEvents) await analysisEvents.close()
  if (analysisQueue) { await analysisQueue.obliterate({ force: true }); await analysisQueue.close(); report.referenceAnalysisQueueRemoved = true }
  if (worker) await worker.close()
  if (executionWorker) await executionWorker.close()
  if (executionEvents) await executionEvents.close()
  if (riskWorker) await riskWorker.close()
  if (riskEvents) await riskEvents.close()
  if (queueEvents) await queueEvents.close()
  if (queue) { await queue.obliterate({ force: true }); await queue.close(); report.referenceQueueRemoved = true }
  if (riskQueue) { await riskQueue.obliterate({ force: true }); await riskQueue.close(); report.referenceRiskQueueRemoved = true }
  if (executionQueue) { await executionQueue.obliterate({ force: true }); await executionQueue.close(); report.referenceExecutionQueueRemoved = true }
  if (routes && gatewayRoute) {
    await routes.release(gatewayRoute)
    assert.equal(await routes.current('5'), null)
    const keys = [`${gatewayPrefix}:user:7:connections`, `${gatewayPrefix}:user:7:profile:profile_12345678`, `${gatewayPrefix}:account:5`, `${gatewayPrefix}:connection:connection_12345678`]
    await leaseRedis.del(...keys)
    assert.equal(await leaseRedis.exists(...keys), 0)
    report.referenceGatewayRouteRemoved = true
  }
  if (leaseRedis) { if (leaseKey) await leaseRedis.del(leaseKey); await leaseRedis.quit(); report.referenceLeaseRemoved = true }
  if (pool) await pool.end()
  if (db) { if (created) { assert.match(name, /^dev_vue_analysis_ref_[a-f0-9]{32}$/); await db.query('DROP DATABASE `' + name + '`'); report.referenceDatabaseRemoved = true } await db.end() }
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close()
  console.log(JSON.stringify(report))
}
