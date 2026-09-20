import {verifyPositionProtectionPreparation} from './lib/position-protection-preparation-reference.mjs'
import { verifyQuoteProvenanceReference } from './lib/quote-provenance-reference.mjs'
import { verifyPartialCloseFullSchema } from './lib/partial-close-full-schema-reference.mjs'
import { verifyPartialCloseProgressReference } from './lib/partial-close-progress-reference.mjs'
import { verifyBridgeCommandLifecycleReference } from './lib/bridge-command-lifecycle-reference.mjs'
import { verifyPartialCloseParentReference } from './lib/partial-close-parent-reference.mjs'
import { verifyPartialCloseReceiptReference } from './lib/partial-close-receipt-reference.mjs'
import { verifyPartialCloseWorkflowReference } from './lib/partial-close-workflow-reference.mjs'
import { verifyEntryAnalysisReference } from './lib/entry-analysis-reference.mjs'
import { verifyInferenceBuildReference } from './lib/inference-build-reference.mjs'
import assert from 'node:assert/strict'
import { verifyModelAccessReference } from './lib/model-access-reference.mjs'
import { verifyAnalysisSourceReference } from './lib/analysis-source-reference.mjs'
import { verifyHistoryCollectionReceiptReference } from './lib/history-collection-receipt-reference.mjs'
import { verifyStrategyObserverAccessReference } from './lib/strategy-observer-access-reference.mjs'
import { readFile, open } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { splitSqlStatements } from './lib/v4-migration-plan.mjs'
import { MysqlAnalysisScheduleStore } from '../server/dist-v4/modules/strategies/infrastructure/mysql-analysis-schedule-store.js'
import { createMysqlStrategyService } from '../server/dist-v4/modules/strategies/composition.js'
import { verifyStrategyRoleIdentityReference } from './lib/strategy-role-identity-reference.mjs'
import { verifyStrategySourceWriteReference } from './lib/strategy-source-write-reference.mjs'
import { verifyProposedEvidenceReference } from './lib/proposed-evidence-reference.mjs'
import { verifySubscriptionBuildWriterReference } from './lib/subscription-build-writer-reference.mjs'
import { verifySubscriptionSourceWriteReference } from './lib/subscription-source-write-reference.mjs'
import { verifyRuntimeMemoryReference } from './lib/runtime-memory-reference.mjs'
import { verifySubscriptionRootPromotion } from './lib/subscription-root-promotion-reference.mjs'
import { verifyPendingOriginReference } from './lib/pending-origin-reference.mjs'

const [mode, destination] = process.argv.slice(2)
assert.ok(['--temporary-reference-only','--canonical-subscription-only','--strategy-reference-only','--protection-reference-only','--parent-dispatch-reference-only'].includes(mode) && process.argv.length === 4 && isAbsolute(destination ?? ''))
const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
const credential = JSON.parse(Buffer.concat(chunks).toString('utf8'))
assert.ok(credential.host === '127.0.0.1' && credential.port === 13316 && credential.user === 'root')
const database = 'dev_vue_strategy_ref_' + randomUUID().replaceAll('-', '')
assert.match(database, /^dev_vue_strategy_ref_[0-9a-f]{32}$/)
const output = await open(destination, 'wx', 0o600)
const report = { kind: 'strategy-write-schema-reference/v1', passed: false, existingDatabaseWrites: 0,
  referenceDatabaseRemoved: false, scaffoldParents: ['users', 'trading_accounts', 'trading_account_ownerships'], checks: [] }
let connection, pool, created = false
const sha = value => createHash('sha256').update(value).digest('hex')
try {
  const receiptSql = await readFile(new URL('../server/db/migrations/inplace/048_strategy_write_receipts.sql', import.meta.url), 'utf8')
  report.migrationSha256 = sha(receiptSql)
  const original = await readFile(new URL('../server/db/migrations/20260903_004_ai_strategy_and_inference_core.sql', import.meta.url), 'utf8')
  const preferences = await readFile(new URL('../server/db/migrations/20260907_027_subscription_execution_preferences.sql', import.meta.url), 'utf8')
  report.parentSources = { strategy: sha(original), preferences: sha(preferences) }
  const artifactPaths = [
    'scripts/lib/partial-close-parent-dispatch-transaction-reference.mjs',
    'scripts/lib/partial-close-parent-result-transaction-reference.mjs',
    'scripts/lib/partial-close-parent-progress-chain-reference.mjs',
    'scripts/lib/partial-close-parent-dispatch-reference.mjs','server/db/migrations/inplace/066_partial_close_parent_dispatches.sql',
    'server/src/modules/execution/infrastructure/mysql-partial-close-parent-dispatch-review.ts','server/dist-v4/modules/execution/infrastructure/mysql-partial-close-parent-dispatch-review.js',
    'scripts/lib/position-protection-result-transaction-reference.mjs','server/src/modules/execution/infrastructure/mysql-position-protection-result-wakeup.ts','server/dist-v4/modules/execution/infrastructure/mysql-position-protection-result-wakeup.js',
    'scripts/lib/position-protection-reconciliation-reference.mjs','server/db/migrations/inplace/065_bridge_reconciliation_outbox_index.sql',
    'server/src/modules/execution/infrastructure/mysql-position-protection-reconciliation-request.ts','server/dist-v4/modules/execution/infrastructure/mysql-position-protection-reconciliation-request.js',
    'server/src/modules/execution/application/position-protection-receiver-context.ts','server/dist-v4/modules/execution/application/position-protection-receiver-context.js','server/src/modules/execution/application/position-protection-preparation-receiver.ts','server/dist-v4/modules/execution/application/position-protection-preparation-receiver.js','server/src/bootstrap/position-protection-preparation-runtime.ts','server/dist-v4/bootstrap/position-protection-preparation-runtime.js',
    'scripts/lib/subscription-canonical-source-batch.mjs','scripts/lib/schema-transition-reference.mjs','scripts/lib/execution-foundation-reference.mjs','scripts/lib/inference-root-schema-state.mjs','scripts/lib/inference-root-promotion.mjs','scripts/lib/partial-close-full-schema-reference.mjs','server/src/bootstrap/partial-close-runtime.ts','server/dist-v4/bootstrap/partial-close-runtime.js','scripts/lib/position-protection-receiver-reference.mjs','scripts/lib/position-protection-unissued-reference.mjs','server/db/migrations/inplace/062_position_protection_unissued_expiries.sql','server/src/modules/execution/infrastructure/mysql-position-protection-unissued-expiry.ts','server/dist-v4/modules/execution/infrastructure/mysql-position-protection-unissued-expiry.js','server/src/modules/execution/application/position-protection-receivers.ts','server/dist-v4/modules/execution/application/position-protection-receivers.js','server/src/modules/execution/infrastructure/mysql-position-protection-receiver-scope.ts','server/dist-v4/modules/execution/infrastructure/mysql-position-protection-receiver-scope.js','server/src/bootstrap/position-protection-outcome.ts','server/dist-v4/bootstrap/position-protection-outcome.js','server/src/modules/execution/infrastructure/mysql-position-protection-outcome-service.ts','server/dist-v4/modules/execution/infrastructure/mysql-position-protection-outcome-service.js','server/src/modules/execution/application/position-protection-outcome-service.ts','server/src/modules/execution/infrastructure/mysql-position-protection-outcome-receipt.ts','server/dist-v4/modules/execution/infrastructure/mysql-position-protection-outcome-receipt.js','server/db/migrations/inplace/061_position_protection_outcomes.sql','server/src/modules/execution/infrastructure/mysql-position-protection-outcome-merge.ts','server/dist-v4/modules/execution/infrastructure/mysql-position-protection-outcome-merge.js','scripts/lib/position-protection-outcome-reference.mjs','server/src/modules/execution/domain/position-protection-outcome.ts','server/dist-v4/modules/execution/domain/position-protection-outcome.js','server/src/modules/execution/infrastructure/mysql-position-protection-success-receipt.ts','server/dist-v4/modules/execution/infrastructure/mysql-position-protection-success-receipt.js','server/db/migrations/inplace/060_position_protection_dispatches.sql','server/src/modules/execution/infrastructure/mysql-position-protection-dispatch-writer.ts','server/dist-v4/modules/execution/infrastructure/mysql-position-protection-dispatch-writer.js','server/src/bootstrap/position-protection-dispatch.ts','server/dist-v4/bootstrap/position-protection-dispatch.js','server/src/modules/execution/domain/position-protection-dispatch-review.ts','server/dist-v4/modules/execution/domain/position-protection-dispatch-review.js','server/src/modules/execution/infrastructure/mysql-position-protection-dispatch-review.ts','server/dist-v4/modules/execution/infrastructure/mysql-position-protection-dispatch-review.js','server/src/bootstrap/position-protection-command-provider.ts','server/dist-v4/bootstrap/position-protection-command-provider.js','server/src/modules/execution/infrastructure/position-protection-command-provider.ts','scripts/lib/position-protection-binding-reference.mjs','server/db/migrations/inplace/059_position_protection_commands.sql','server/src/modules/execution/domain/position-protection-command-binding.ts','server/dist-v4/modules/execution/domain/position-protection-command-binding.js','server/src/modules/execution/infrastructure/mysql-position-protection-command-binding.ts','server/dist-v4/modules/execution/infrastructure/mysql-position-protection-command-binding.js','scripts/lib/position-protection-command-reference.mjs','server/src/modules/execution/domain/position-protection-command-review.ts','server/dist-v4/modules/execution/domain/position-protection-command-review.js','server/src/modules/execution/infrastructure/mysql-position-protection-command-reviewer.ts','server/dist-v4/modules/execution/infrastructure/mysql-position-protection-command-reviewer.js','scripts/lib/partial-close-queue-reference.mjs','server/src/queue/partial-close-workflow-queue.ts','server/dist-v4/queue/partial-close-workflow-queue.js','server/src/queue/partial-close-workflow-processor.ts','server/dist-v4/queue/partial-close-workflow-processor.js','server/src/outbox/infrastructure/partial-close-outbox-task.ts','server/dist-v4/outbox/infrastructure/partial-close-outbox-task.js','server/src/outbox/infrastructure/mysql-outbox-repository.ts','server/dist-v4/outbox/infrastructure/mysql-outbox-repository.js','server/src/outbox/infrastructure/bullmq-outbox-task-publisher.ts','server/dist-v4/outbox/infrastructure/bullmq-outbox-task-publisher.js','server/src/modules/execution/application/partial-close-workflow-worker.ts','server/dist-v4/modules/execution/application/partial-close-workflow-worker.js','server/src/modules/execution/infrastructure/mysql-partial-close-workflow-recovery.ts','server/dist-v4/modules/execution/infrastructure/mysql-partial-close-workflow-recovery.js','server/src/modules/execution/infrastructure/mysql-position-protection-expiry.ts','server/dist-v4/modules/execution/infrastructure/mysql-position-protection-expiry.js','server/src/bootstrap/position-protection-preparation.ts','server/dist-v4/bootstrap/position-protection-preparation.js','server/db/migrations/20260903_009_execution_intents_and_reservations.sql','server/db/migrations/20260904_011_user_execution_commands_and_distributions.sql','server/db/migrations/corrections/011-execution-intent-foreign-keys.sql','server/src/modules/execution/application/position-protection-preparation.ts','scripts/lib/position-protection-preparation-reference.mjs','server/db/migrations/inplace/058_position_protection_children.sql','server/src/modules/execution/infrastructure/mysql-position-protection-preparation.ts','server/dist-v4/modules/execution/infrastructure/mysql-position-protection-preparation.js','server/src/modules/execution/infrastructure/mysql-position-protection-child-writer.ts','server/dist-v4/modules/execution/infrastructure/mysql-position-protection-child-writer.js','server/src/modules/execution/domain/position-protection-child.ts','server/dist-v4/modules/execution/domain/position-protection-child.js','server/dist-v4/modules/execution/domain/partial-close-protection.js','scripts/lib/position-protection-context-reference.mjs','server/src/bootstrap/position-protection-review.ts','server/dist-v4/bootstrap/position-protection-review.js','server/src/modules/trading/infrastructure/mysql-execution-source-evidence.ts','server/dist-v4/modules/trading/infrastructure/mysql-execution-source-evidence.js','server/src/modules/trading/infrastructure/mysql-execution-quote-reader.ts','server/dist-v4/modules/trading/infrastructure/mysql-execution-quote-reader.js','server/src/modules/trading/infrastructure/mysql-execution-instrument-reader.ts','server/dist-v4/modules/trading/infrastructure/mysql-execution-instrument-reader.js','server/src/modules/risk/domain/position-protection-risk.ts','server/dist-v4/modules/risk/domain/position-protection-risk.js','scripts/lib/quote-upgrade-coordinator-reference.mjs','scripts/lib/quote-provenance-upgrade.mjs','scripts/generate-quote-provenance-schema-readiness.mjs','server/src/modules/trading/infrastructure/quote-provenance-schema.ts','server/src/modules/trading/infrastructure/mysql-schema-readiness.ts','server/dist-v4/modules/trading/infrastructure/mysql-schema-readiness.js','scripts/lib/quote-provenance-reference.mjs','server/db/migrations/inplace/057_market_quote_provenance.sql','server/src/modules/trading/infrastructure/mysql-quote-provenance-writer.ts','server/dist-v4/modules/trading/infrastructure/mysql-quote-provenance-writer.js','server/src/modules/trading/application/quote-provenance-writer.ts','server/src/modules/trading/infrastructure/mysql-trading-repository.ts','server/dist-v4/modules/trading/infrastructure/mysql-trading-repository.js','scripts/lib/execution-account-reference.mjs','server/src/modules/trading/infrastructure/mysql-execution-account-reader.ts','server/dist-v4/modules/trading/infrastructure/mysql-execution-account-reader.js','server/src/modules/trading/application/execution-account-reader.ts','scripts/lib/position-protection-risk-input-reference.mjs','server/src/modules/risk/infrastructure/mysql-position-protection-summary-reader.ts','server/dist-v4/modules/risk/infrastructure/mysql-position-protection-summary-reader.js','server/src/modules/risk/infrastructure/mysql-position-protection-clock.ts','server/dist-v4/modules/risk/infrastructure/mysql-position-protection-clock.js','server/src/modules/risk/application/position-protection-summary-reader.ts','scripts/lib/partial-close-receipt-reference.mjs','server/src/modules/execution/domain/partial-close-receipt.ts','server/dist-v4/modules/execution/domain/partial-close-receipt.js','server/src/modules/execution/infrastructure/mysql-partial-close-receipt-reader.ts','server/dist-v4/modules/execution/infrastructure/mysql-partial-close-receipt-reader.js','server/src/modules/execution/application/partial-close-receipt-reader.ts','scripts/lib/execution-position-reference.mjs','server/src/modules/trading/infrastructure/mysql-execution-position-collection-reader.ts','server/dist-v4/modules/trading/infrastructure/mysql-execution-position-collection-reader.js','server/src/bootstrap/partial-close-progress.ts','server/dist-v4/bootstrap/partial-close-progress.js','server/src/modules/trading/infrastructure/mysql-execution-position-reader.ts','server/dist-v4/modules/trading/infrastructure/mysql-execution-position-reader.js','server/src/modules/trading/application/execution-position-reader.ts','server/src/bootstrap/partial-close-registration.ts','server/dist-v4/bootstrap/partial-close-registration.js','scripts/lib/partial-close-workflow-reference.mjs','server/db/migrations/inplace/056_partial_close_workflows.sql','server/src/modules/execution/infrastructure/mysql-partial-close-workflow-writer.ts','server/dist-v4/modules/execution/infrastructure/mysql-partial-close-workflow-writer.js','server/src/modules/execution/application/partial-close-workflow-store.ts','server/src/modules/execution/domain/partial-close-protection.ts','server/src/modules/inference/application/reference-entry-evidence.ts','server/dist-v4/modules/inference/application/reference-entry-evidence.js','server/src/modules/inference/application/read-strategy-reference-portfolio.ts','server/src/modules/inference/application/strategy-reference-portfolio.ts','scripts/lib/entry-analysis-reference.mjs','server/src/modules/inference/infrastructure/mysql-trade-decision-entry-analysis-reader.ts','server/dist-v4/modules/inference/infrastructure/mysql-trade-decision-entry-analysis-reader.js','scripts/lib/inference-build-reference.mjs','scripts/lib/inference-build-schema.mjs','server/src/modules/inference/application/reference-position-creation.ts',
    'server/dist-v4/modules/inference/application/reference-position-creation.js','server/src/modules/execution/domain/opening-order-ticket.ts',
    'server/dist-v4/modules/execution/domain/opening-order-ticket.js','scripts/verify-strategy-write-reference-local.mjs',
    'scripts/lib/partial-close-progress-reference.mjs','server/src/modules/execution/infrastructure/mysql-partial-close-workflow-progress.ts','server/dist-v4/modules/execution/infrastructure/mysql-partial-close-workflow-progress.js',
    'server/src/modules/execution/application/partial-close-workflow-progress.ts','server/dist-v4/modules/execution/application/partial-close-workflow-progress.js',
    'scripts/lib/partial-close-parent-reference.mjs','scripts/lib/bridge-command-lifecycle-reference.mjs',
    ...['bridge-command-sql-time','bridge-command-transaction','mysql-bridge-command-repository','mysql-command-source-action'].flatMap(name => [`server/src/modules/execution/infrastructure/${name}.ts`,`server/dist-v4/modules/execution/infrastructure/${name}.js`]),
    'server/src/modules/execution/domain/partial-close-plan.ts','server/dist-v4/modules/execution/domain/partial-close-plan.js', 'scripts/run-strategy-write-reference-local.py',
    'scripts/lib/strategy-role-identity-reference.mjs', 'scripts/lib/strategy-role-legacy-identity.mjs',
    'scripts/lib/mysql-strategy-role-writer.mjs',
    'scripts/lib/strategy-source-write-reference.mjs', 'scripts/lib/mysql-strategy-source-writer.mjs',
    'scripts/lib/strategy-source-batch.mjs', 'scripts/lib/proposed-evidence-reference.mjs',
    'scripts/lib/frozen-source-batch.mjs', 'scripts/lib/subscription-source-batch.mjs',
    'scripts/lib/v4-subscription-preferences-conversion.mjs', 'server/dist-v4/modules/strategies/domain/subscription-take-profit.js',
    'scripts/lib/runtime-memory-reference.mjs', 'server/dist-v4/modules/reviews/infrastructure/mysql-runtime-strategy-memory-reader.js',
    'server/db/migrations/inplace/050_strategy_memory_runtime_audit.sql',
    'scripts/lib/runtime-memory-preparation-reference.mjs',
    'scripts/lib/subscription-execution-window-reference.mjs',
    'server/dist-v4/modules/strategies/infrastructure/mysql-subscription-execution-window-reader.js',
    'server/dist-v4/modules/strategies/infrastructure/mysql-analysis-subscriber-reader.js',
    'server/dist-v4/modules/strategies/infrastructure/mysql-analysis-window-reader.js',
    'scripts/lib/model-access-reference.mjs',
    'scripts/lib/analysis-source-reference.mjs',
    'scripts/lib/history-collection-receipt-reference.mjs',
    'server/db/migrations/inplace/051_history_collection_receipts.sql',
    'server/dist-v4/modules/trade-history/application/history-collection-receipt.js',
    'server/dist-v4/modules/trade-history/infrastructure/mysql-history-collection-receipt-writer.js',
    'scripts/lib/strategy-reference-source-reference.mjs',
    'contracts/bridge-v4.schema.json',
    'server/dist-v4/modules/bridge/application/bridge-trade-projection-decoder.js',
    'server/dist-v4/bootstrap/strategy-reference-evidence.js',
    'server/dist-v4/modules/inference/application/reference-pending-creation.js',
    'server/dist-v4/modules/inference/infrastructure/mysql-strategy-reference-source-reader.js',
    'scripts/lib/strategy-observer-access-reference.mjs',
    'scripts/lib/strategy-observer-inventory-reference.mjs',
    'server/dist-v4/modules/trading/infrastructure/mysql-strategy-observer-inventory-reader.js',
    'server/dist-v4/modules/trading/infrastructure/mysql-observer-access-reader.js',
    'server/dist-v4/modules/inference/infrastructure/mysql-analysis-source-reader.js',
    'server/dist-v4/modules/strategies/infrastructure/mysql-runtime-strategy-access.js',
    'server/dist-v4/modules/inference/infrastructure/mysql-model-gateway-resolver.js',
    'server/dist-v4/modules/inference/infrastructure/mysql-model-usage-ledger.js',
    'server/dist-v4/modules/auth/infrastructure/mysql-account-principal-reader.js',
    'server/dist-v4/modules/auth/infrastructure/mysql-active-principal-access.js',
    'server/dist-v4/modules/trading/infrastructure/mysql-account-inventory-summary-reader.js',
    'server/dist-v4/modules/risk/infrastructure/mysql-account-risk-summary-reader.js',
    'scripts/lib/subscription-root-promotion.mjs', 'scripts/lib/subscription-root-promotion-reference.mjs',
    'scripts/lib/pending-origin-reference.mjs',
    'server/dist-v4/modules/execution/infrastructure/mysql-pending-origin-reader.js',
    'server/dist-v4/modules/execution/infrastructure/mysql-pending-order-origin-reader.js',
    'server/dist-v4/modules/inference/infrastructure/mysql-trade-decision-origin-reader.js',
    'server/dist-v4/modules/reviews/infrastructure/mysql-runtime-memory-preparation-writer.js',
    'server/dist-v4/modules/inference/application/memory-preparation-for-snapshot.js',
    'server/dist-v4/modules/inference/infrastructure/mysql-inference-repository.js',
    'scripts/lib/mysql-subscription-build-writer.mjs', 'scripts/lib/subscription-build-writer-reference.mjs',
    'scripts/lib/mysql-subscription-source-writer.mjs', 'scripts/lib/subscription-source-write-reference.mjs', 'scripts/lib/subscription-legacy-identity.mjs',
    'server/dist-v4/modules/inference/infrastructure/mysql-proposed-decision-evidence-reader.js',
    'server/db/migrations/inplace/005_source_row_evidence.sql',
    'scripts/lib/v4-backfill-mysql-repository.mjs', 'server/db/migrations/20260906_025_data_migration_batch_ledger.sql',
    'server/dist-v4/modules/strategies/application/strategy-service.js', 'server/dist-v4/modules/strategies/application/strategy-write-command.js',
    ...['mysql-strategy-catalog', 'mysql-strategy-create', 'mysql-strategy-metadata', 'mysql-owned-strategy-write',
      'mysql-strategy-version-writes', 'mysql-strategy-write-receipts', 'strategy-transaction', 'strategy-sql-time',
      'mysql-analysis-schedule-store', 'mysql-subscription-execution-preferences'].map(name => `server/dist-v4/modules/strategies/infrastructure/${name}.js`)]
  report.artifacts = await Promise.all(artifactPaths.map(async path => ({ path, sha256: sha(await readFile(new URL('../' + path, import.meta.url))) })))
  connection = await mysql.createConnection({ ...credential, timezone: 'Z', multipleStatements: false })
  const [[server]] = await connection.query('SELECT @@server_uuid uuid,@@version version')
  assert.equal(server.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  report.serverUuid = server.uuid; report.serverVersion = server.version
  await connection.query(`CREATE DATABASE \`${database}\``); created = true
  await connection.query(`USE \`${database}\``)
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query("CREATE TABLE users (id INT PRIMARY KEY,deletion_status VARCHAR(20) NOT NULL,deleted_at DATETIME(3) NULL) ENGINE=InnoDB")
  await connection.query('CREATE TABLE trading_accounts (id BIGINT UNSIGNED PRIMARY KEY,deleted_at_utc DATETIME(3) NULL) ENGINE=InnoDB')
  await connection.query("CREATE TABLE trading_account_ownerships (id BIGINT UNSIGNED PRIMARY KEY,user_id INT NOT NULL,trading_account_id BIGINT UNSIGNED NOT NULL,role VARCHAR(20) NOT NULL,revoked_at_utc DATETIME(3) NULL) ENGINE=InnoDB")
  const parentSql = splitSqlStatements(original).filter(sql => /^(CREATE TABLE IF NOT EXISTS (strategies|strategy_versions|strategy_subscriptions|subscription_schedules)\s|ALTER TABLE strategies\s)/.test(sql))
  assert.equal(parentSql.length, 5)
  for (const sql of parentSql) await connection.query(sql)
  for (const sql of splitSqlStatements(preferences)) await connection.query(sql)
  assert.equal(splitSqlStatements(receiptSql).length, 1)
  await connection.query(receiptSql)
  const [[definition]] = await connection.query('SHOW CREATE TABLE strategy_write_receipts_v4')
  report.canonicalDdl = definition['Create Table']
  await connection.query("INSERT INTO users VALUES (7,'active',NULL)")
  await connection.query('INSERT INTO trading_accounts VALUES (5,NULL)')
  await connection.query("INSERT INTO trading_account_ownerships VALUES (1,7,5,'owner',NULL)")
  pool = mysql.createPool({ ...credential, database, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true, connectionLimit: 4 })
  let loseAck = false
  const wrapped = new Proxy(pool, { get(target, name) {
    if (name === 'getConnection') return async () => {
      const db = await target.getConnection()
      await db.query("SET SESSION time_zone='+00:00'")
      return new Proxy(db, { get(client, method) {
        if (method === 'commit') return async () => { await client.commit(); if (loseAck) { loseAck = false; throw Error('injected_postcommit_ack_loss') } }
        const value = Reflect.get(client, method); return typeof value === 'function' ? value.bind(client) : value
      } })
    }
    const value = Reflect.get(target, name); return typeof value === 'function' ? value.bind(target) : value
  } })
  const service = createMysqlStrategyService(wrapped)
  const key = label => `strategy-reference-${label}`
  const create = { idempotencyKey: key('create'), kind: 'analysis', name: 'reference', description: '', promptText: 'analyse', config: {} }
  loseAck = true
  await assert.rejects(service.create(7, create), { code: 'strategy_commit_unknown' })
  const analysis = await service.create(7, create), id = analysis.summary.id
  assert.equal(analysis.summary.revision, 1)
  await assert.rejects(service.create(7, { ...create, name: 'different' }), { code: 'strategy_idempotency_conflict' })
  report.checks.push('real_create_commit_then_injected_ack_loss_recovered_and_conflict_rejected')
  const concurrent = { ...create, idempotencyKey: key('concurrent') }
  const [first, second] = await Promise.all([service.create(7, concurrent), service.create(7, concurrent)])
  assert.deepEqual(first, second)
  const [[strategyCount]] = await connection.query('SELECT COUNT(*) quantity FROM strategies')
  assert.equal(strategyCount.quantity, 2)
  report.checks.push('concurrent_same_key_one_strategy')
  const metadata = { userId: 7, strategyId: id, expectedRevision: 1, idempotencyKey: key('metadata'), name: 'changed', description: '' }
  report.stage = 'update_metadata'
  const changed = await service.updateMetadata(metadata)
  const versionCommand = { userId: 7, strategyId: id, expectedRevision: 2, idempotencyKey: key('version'), promptText: 'new version', config: {} }
  report.stage = 'create_version'
  const versioned = await service.createVersion(versionCommand)
  assert.equal(versioned.versions.length, 2)
  const publish = { userId: 7, strategyId: id, versionId: versioned.versions[0].id, expectedRevision: 3, idempotencyKey: key('publish') }
  report.stage = 'publish_version'
  await service.publishVersion(publish)
  const subscriptionCommand = { idempotencyKey: key('subscription'), tradingAccountId: '5', standardSymbol: 'XAUUSD', analysisStrategyId: id }
  report.stage = 'create_subscription'
  const subscription = await service.createSubscription(7, subscriptionCommand)
  const schedules = new MysqlAnalysisScheduleStore(wrapped)
  const due = await schedules.listDue(new Date(Date.now() + 600_000).toISOString(), 10)
  assert.equal(due.length, 1); assert.equal(due[0].subscriptionId, subscription.id)
  const expectedDue = subscription.schedule.nextDueAt, nextDue = new Date(Date.parse(expectedDue) + 300_000).toISOString()
  assert.equal(await schedules.advance(subscription.id, expectedDue, nextDue), true)
  assert.equal(await schedules.advance(subscription.id, expectedDue, nextDue), false)
  report.checks.push('real_schedule_query_and_compare_swap_utc_bindings')
  const update = { userId: 7, subscriptionId: subscription.id, expectedRevision: 1, idempotencyKey: key('update'), status: 'ended' }
  report.stage = 'update_subscription'
  const ended = await service.updateSubscription(update)
  const retired = await service.retire({ userId: 7, strategyId: id, expectedRevision: 4, idempotencyKey: key('retire') })
  assert.equal(retired.summary.status, 'retired')
  assert.deepEqual(await service.updateMetadata(metadata), changed)
  assert.deepEqual(await service.createVersion(versionCommand), versioned)
  assert.deepEqual(await service.createSubscription(7, subscriptionCommand), subscription)
  assert.deepEqual(await service.updateSubscription(update), ended)
  report.checks.push('seven_real_write_kinds_and_historical_replay_after_retirement_or_end')
  const [[before]] = await connection.query('SELECT COUNT(*) quantity FROM strategy_write_receipts_v4')
  await assert.rejects(service.create(7, { ...create, idempotencyKey: key('invalid'), config: { script: 'unsupported' } }), { code: 'strategy_compile_invalid' })
  const [[after]] = await connection.query('SELECT COUNT(*) quantity FROM strategy_write_receipts_v4')
  assert.equal(after.quantity, before.quantity)
  await connection.query('UPDATE trading_account_ownerships SET revoked_at_utc=UTC_TIMESTAMP(3) WHERE id=1')
  await assert.rejects(service.createSubscription(7, subscriptionCommand), { code: 'strategy_account_forbidden' })
  await connection.query("UPDATE users SET deletion_status='deleted' WHERE id=7")
  await assert.rejects(service.create(7, create), { code: 'strategy_actor_forbidden' })
  report.checks.push('failed_prepare_no_receipt_and_revoked_authority_replay_rejected')
  const invalidReceiptSql = `INSERT INTO strategy_write_receipts_v4
    (actor_user_id,idempotency_key,action,request_sha256,resource_id,result_revision,result_json,result_sha256,recorded_at_utc)
    VALUES (?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3))`
  for (const [index, value, code] of [[0, 999, 'ER_NO_REFERENCED_ROW_2'], [2, 'invalid', 'ER_CHECK_CONSTRAINT_VIOLATED'],
    [3, 'A'.repeat(64), 'ER_CHECK_CONSTRAINT_VIOLATED'], [5, 0, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    [6, '[]', 'ER_CHECK_CONSTRAINT_VIOLATED'], [1, 'short', 'ER_CHECK_CONSTRAINT_VIOLATED']]) {
    const params = [7, randomUUID(), 'create_strategy', 'a'.repeat(64), id, 1, '{}', 'b'.repeat(64)]
    params[index] = value
    await assert.rejects(connection.execute(invalidReceiptSql, params), { code })
  }
  report.checks.push('receipt_foreign_key_and_five_check_rejections')
  report.stage = 'strategy_role_legacy_identity'
  report.roleIdentity = await verifyStrategyRoleIdentityReference(connection)
  report.checks.push('role_legacy_keys_real_unique_constraints_and_composite_version_fk')
  report.stage = 'strategy_source_write'
  report.sourceWrite = await verifyStrategySourceWriteReference(connection, pool)
  report.checks.push('source_and_maps_atomic_rollback_commit_ack_loss_and_replay')
  report.stage = 'subscription_build_writer'
  report.subscriptionBuild = await verifySubscriptionBuildWriterReference(connection, id, versioned.versions[0].id)
  report.checks.push('subscription_build_three_table_write_and_conflict_replay')
  report.stage = 'subscription_source_writer'
  report.subscriptionSource = await verifySubscriptionSourceWriteReference(connection, pool, {canonical:mode==='--canonical-subscription-only'})
  report.checks.push('subscription_source_and_parent_maps_atomic_backfill')
  if(mode==='--parent-dispatch-reference-only'){
    const ddl=splitSqlStatements(original).find(sql=>sql.startsWith('CREATE TABLE IF NOT EXISTS outbox_events ('))
    assert.ok(ddl);await connection.query(ddl)
    report.stage='parent_dispatch_reference'
    report.partialCloseWorkflow=await verifyPartialCloseWorkflowReference(connection,pool)
    report.partialCloseParent=await verifyPartialCloseParentReference(connection,pool,{dispatchTransaction:true})
    report.passed=true;report.scope='parent-dispatch-reference-only'
  }else if(mode==='--protection-reference-only'){
    report.stage='position_protection_preparation'
    report.positionProtectionPreparation=await verifyPositionProtectionPreparation(pool)
    report.passed=true;report.scope='position-protection-reference-only'
  }else if(mode==='--strategy-reference-only'){
    // Pending-origin verification derives its two temporary inference tables from this DDL.
    const source=(await Promise.all(['20260903_005_analysis_scheduler_and_account_fanout.sql','20260903_006_account_trader_worker.sql','20260903_007_deterministic_risk_review.sql']
      .map(file=>readFile(new URL('../server/db/migrations/'+file,import.meta.url),'utf8')))).join('\n')
    for(const table of ['ai_trader_runs','trade_decisions']){
      const ddl=splitSqlStatements(original).find(sql=>sql.startsWith(`CREATE TABLE IF NOT EXISTS ${table} (`))
      assert.ok(ddl)
      await connection.query(ddl.split('\n').filter(line=>!line.includes('FOREIGN KEY')).join('\n').replace(/,\s*\)/g,')'))
      for(const sql of splitSqlStatements(source).filter(sql=>sql.startsWith(`ALTER TABLE ${table}\n`)))await connection.query(sql.split('\n').filter(line=>!line.includes('FOREIGN KEY')).join('\n').replace(/,\s*$/,''))
    }
    report.stage='strategy_reference_portfolio'
    report.strategyObserverAccess=await verifyStrategyObserverAccessReference(connection)
    report.passed=true;report.scope='strategy-reference-portfolio-temporary-sql-only'
  }else if(mode==='--canonical-subscription-only'){report.passed=true;report.scope='canonical-subscription-reference-only'}else{
  report.stage = 'proposed_evidence_schema'
  // Empty isolated reference only: never use these side-by-side migrations to upgrade dev_vue.
  for (const sql of splitSqlStatements(original).filter(sql => !parentSql.includes(sql))) await connection.query(sql)
  report.evidenceMigrationSources = []
  for (const file of ['20260903_005_analysis_scheduler_and_account_fanout.sql', '20260903_006_account_trader_worker.sql',
    '20260903_007_deterministic_risk_review.sql']) {
    const sql = await readFile(new URL('../server/db/migrations/' + file, import.meta.url), 'utf8')
    report.evidenceMigrationSources.push({ file, sha256: sha(sql) })
    for (const statement of splitSqlStatements(sql)) await connection.query(statement)
  }
  report.stage = 'inference_build_schema'
  report.inferenceBuild = await verifyInferenceBuildReference(connection,id,versioned.versions[0].id)
  report.stage = 'entry_analysis_query'
  report.entryAnalysis = await verifyEntryAnalysisReference(connection,id,versioned.versions[0].id,subscription.id)
  report.checks.push('historical-entry-analysis-three-payload-lineage')
  report.stage = 'proposed_evidence_query'
  report.proposedEvidence = await verifyProposedEvidenceReference(connection)
  report.checks.push('proposed_evidence_sql_on_migration_derived_temporary_tables')
  report.stage = 'runtime_memory_reader'
  report.runtimeMemory = await verifyRuntimeMemoryReference(connection, pool)
  report.checks.push('runtime_memory_reader_scope_digest_and_current_revision')
  report.stage = 'subscription_namespace_promotion'
  await verifySubscriptionRootPromotion(connection, report, database => mysql.createConnection({ ...credential, database,
    timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true }))
  report.checks.push('subscription_namespace_rename_preserves_legacy_and_runtime_data')
  report.stage = 'pending_origin_query'
  await verifyPendingOriginReference(connection, report)
  report.checks.push('pending_origin_public_reader_real_sql_scope_and_lineage')
  report.stage = 'model_access_and_quota'
  report.modelAccess = await verifyModelAccessReference(connection, pool)
  report.checks.push('model_strategy_principal_and_concurrent_shared_quota')
  report.stage = 'analysis_source_lineage'
  report.analysisSource = await verifyAnalysisSourceReference(connection)
  report.checks.push('analysis_source_frozen_lineage_real_sql')
  report.historyCollectionReceipts = await verifyHistoryCollectionReceiptReference(connection)
  report.checks.push('history_collection_receipt_real_sql_rollback_replay_and_constraints')
  report.stage = 'strategy_observer_access'
  report.strategyObserverAccess = await verifyStrategyObserverAccessReference(connection)
  report.checks.push('strategy_observer_access_exact_source_and_current_authority')
  report.stage = 'partial_close_workflow_registration'
  report.partialCloseWorkflow = await verifyPartialCloseWorkflowReference(connection,pool)
  report.checks.push('partial-close-immutable-registration-and-transaction-replay')
  report.stage = 'partial_close_parent_transaction'
  report.partialCloseParent = await verifyPartialCloseParentReference(connection,pool)
  report.checks.push('partial-close-parent-real-transaction-and-commit-uncertainty')
  report.stage = 'partial_close_progress'
  report.partialCloseProgress = await verifyPartialCloseProgressReference(connection,pool)
  report.checks.push('partial-close-durable-review-request-concurrency-and-atomicity')
  report.stage = 'bridge_command_lifecycle'
  report.bridgeCommandLifecycle = await verifyBridgeCommandLifecycleReference(connection,pool)
  report.checks.push('bridge-command-lifecycle-real-SQL-UTC-and-result-recovery')
  report.stage = 'partial_close_receipt_anchor'
  report.partialCloseReceipt = await verifyPartialCloseReceiptReference(connection)
  report.checks.push('partial-close-persisted-result-order-and-deal-anchor')
  report.receiptCount = after.quantity
  report.positionProtectionPreparation = await verifyPositionProtectionPreparation(pool)
  report.quoteProvenance = await verifyQuoteProvenanceReference(pool)
  report.stage = 'inference_root_full_schema'
  report.inferenceRootFullSchema = await verifyPartialCloseFullSchema(pool,{inferencePromotionOnly:true})
  report.stage = 'execution_foundation_full_schema'
  report.executionFoundationFullSchema = await verifyPartialCloseFullSchema(pool,{executionFoundation:true})
  report.stage = 'partial_close_full_schema'
  report.partialCloseFullSchema = await verifyPartialCloseFullSchema(pool)
  assert.equal(report.partialCloseFullSchema.passed,true,'partial_close_full_schema_not_ready')
  report.checks.push('quote-provenance-additive-DDL-and-real-parent-transaction')
  report.passed = true
}
} catch (error) { report.referenceStatement = error?.referenceStatement; report.errorCode = error?.code ?? error?.name ?? 'reference_failed'; report.stageChecks = report.checks.length; if (error?.code === 'ER_TRUNCATED_WRONG_VALUE') report.databaseError = error.sqlMessage;
  if(error?.code==='ER_NO_SUCH_TABLE')report.missingTable=error.sqlMessage?.match(/\.([a-z0-9_]+)' doesn't exist$/)?.[1]
  if(error?.code==='ER_BAD_FIELD_ERROR')report.missingColumn=error.sqlMessage?.match(/^Unknown column '([a-z0-9_.]+)'/)?.[1]
  if (error?.code === 'ERR_ASSERTION') report.assertion = { expectedCode: error.expected?.code, actualCode: error.actual?.code, operator: error.operator }
  process.exitCode = 1 }
finally {
  if (pool) await pool.end()
  if (connection) {
    try { if (created) { await connection.query(`DROP DATABASE \`${database}\``); report.referenceDatabaseRemoved = true } }
    catch { report.passed = false; report.cleanupError = true; report.referenceDatabase = database; process.exitCode = 1 }
    await connection.end()
  }
  report.observedAt = new Date().toISOString()
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close()
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks, errorCode: report.errorCode, stage: report.stage,
    referenceDatabaseRemoved: report.referenceDatabaseRemoved, existingDatabaseWrites: 0 }))
}
