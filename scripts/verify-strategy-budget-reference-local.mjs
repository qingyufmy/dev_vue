import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { loadParentDispatchUpgrade } from './lib/parent-dispatch-upgrade.mjs'
import { verifyBudgetExecutionWindow } from './lib/budget-execution-window-reference.mjs'
import { createDecisionStrategyEvidenceReader } from '../server/dist-v4/modules/inference/composition.js'
import { createStrategyExecutionConfigReader } from '../server/dist-v4/modules/strategies/composition.js'
import { contentHash } from '../server/dist-v4/modules/inference/index.js'
import { readStrategyBudgetContext } from '../server/dist-v4/modules/risk/application/strategy-budget-context.js'
import { calculatePositionTierVolume, positionVolumeExceedsRiskBudget } from '../server/dist-v4/modules/risk/domain/position-tier-sizing.js'

const [destination] = process.argv.slice(2), root = new URL('../', import.meta.url)
assert.ok(process.argv.length === 3 && isAbsolute(destination ?? ''))
const output = await open(destination, 'wx', 0o600)
const name = 'dev_vue_budget_ref_' + randomUUID().replaceAll('-', '')
const report = { kind: 'strategy-budget-mysql-reference/v1', passed: false, existingDatabaseWrites: 0,
  dataCopied: false, foreignKeysVerified: false, referenceDatabaseRemoved: false, checks: [] }
let db, other, created = false, locked = false
try {
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credential = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.ok(credential.host === '127.0.0.1' && credential.port === 13316 && credential.user === 'root')
  const options = { ...credential, timezone: 'Z', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true }
  db = await mysql.createConnection({ ...options, database: 'dev_vue' })
  await db.query("SET SESSION time_zone='+00:00'")
  const [[identity]] = await db.query('SELECT @@server_uuid uuid,@@version version,@@innodb_force_recovery recovery')
  assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104'); assert.equal(Number(identity.recovery), 0)
  report.identity = identity
  const [[lock]] = await db.execute('SELECT GET_LOCK(?,0) acquired', ['aurum:inplace:dev_vue'])
  assert.equal(Number(lock.acquired), 1); locked = true
  const plan = await loadParentDispatchUpgrade(root)
  const [history] = await db.query('SELECT id,checksum_sha256 checksum,status FROM database_upgrade_steps_v4 ORDER BY id')
  assert.equal(history.length, 240)
  const expected = new Map(plan.steps.map(step => [step.id, step.checksum]))
  for (const row of history) { assert.equal(row.status, 'completed'); assert.equal(row.checksum, expected.get(row.id)) }
  report.sourceSteps = history.length
  const tables = ['strategies', 'strategy_versions', 'strategy_subscriptions', 'trading_account_ownerships',
    'trade_decisions', 'trade_decision_payloads', 'ai_trader_runs', 'inference_snapshots', 'inference_snapshot_payloads']
  const definitions = []
  for (const table of tables) {
    const [[row]] = await db.query('SHOW CREATE TABLE `' + table + '`')
    const original = row['Create Table']
    assert.doesNotMatch(original, /REFERENCES\s+`[^`]+`\s*\./i)
    // Keep current columns, generated fields, indexes and CHECKs. The isolated
    // query fixture deliberately omits FKs to unrelated canonical parent data.
    const ddl = original.split('\n').filter(line => !line.includes('FOREIGN KEY')).join('\n').replace(/,\n\)/g, '\n)')
    definitions.push({ table, originalHash: contentHash(original), ddl })
  }
  await db.query('CREATE DATABASE `' + name + '` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'); created = true
  await db.query('USE `' + name + '`')
  for (const definition of definitions) await db.query(definition.ddl)
  report.tables = definitions.map(({ table, originalHash }) => ({ table, originalHash }))
  const insert = async (table, values) => {
    assert.ok(tables.includes(table)); assert.ok(Object.keys(values).every(key => /^[a-z][a-z0-9_]*$/.test(key)))
    await db.execute(`INSERT INTO ${table} (${Object.keys(values).join(',')}) VALUES (${Object.keys(values).map(() => '?').join(',')})`, Object.values(values))
  }
  const now = '2026-09-11 00:00:00.000', prompt = 'Synthetic budget reference'
  const promptHash = createHash('sha256').update(prompt).digest('hex')
  const config = { risk_budget: { version: 1, max_risk_per_trade_percent: '1' } }
  const decision = { action: 'hold', confidence: 80, actions: [] }
  const snapshot = { kind: 'trader', strategy: { id: '20', versionId: '21', promptText: prompt, promptHash },
    account: { id: '5' }, subscriptionRevision: 1, strategyConfigHash: contentHash(config), capturedAt: '2026-09-11T00:00:00.000Z' }
  const strategy = { strategy_id: '20', strategy_version_id: '21' }
  await insert('strategies', { id: '20', kind: 'trader', scope: 'user', owner_user_id: 7, name: 'Synthetic reference', status: 'active', active_version_id: '21', created_at_utc: now, updated_at_utc: now })
  await insert('strategy_versions', { id: '21', strategy_id: '20', version_number: 1, prompt_text: prompt, prompt_sha256: promptHash,
    input_contract_version: 'trader-input/v1', output_contract_version: 'trader-output/v1', config_json: JSON.stringify(config), created_by_user_id: 7, created_at_utc: now })
  await insert('strategy_subscriptions', { id: '8', user_id: 7, trading_account_id: '5', standard_symbol: 'XAUUSD', analysis_strategy_id: '1',
    analysis_strategy_version_id: '11', trader_strategy_id: '20', trader_strategy_version_id: '21', trader_enabled: 1, trade_send_enabled: 1, created_at_utc: now, updated_at_utc: now })
  await insert('trading_account_ownerships', { user_id: 7, trading_account_id: '5', role: 'owner', granted_at_utc: now })
  await insert('inference_snapshots', { id: 'snapshot', purpose: 'trader', user_id: 7, trading_account_id: '5', ...strategy,
    standard_symbol: 'XAUUSD', payload_sha256: contentHash(snapshot), payload_bytes: Buffer.byteLength(JSON.stringify(snapshot)), captured_at_utc: now, created_at_utc: now })
  await insert('inference_snapshot_payloads', { snapshot_id: 'snapshot', payload_json: JSON.stringify(snapshot) })
  await insert('ai_trader_runs', { id: 'run', user_id: 7, trading_account_id: '5', ...strategy, status: 'succeeded', created_at_utc: now,
    updated_at_utc: now, idempotency_key: 'fixture', subscription_id: '8', subscription_revision: 1, market_analysis_id: 'analysis', input_snapshot_id: 'snapshot', task_mode: 'entry', analysis_revision: 2 })
  await insert('trade_decisions', { id: 'decision', trader_run_id: 'run', user_id: 7, trading_account_id: '5', market_analysis_id: 'analysis',
    ...strategy, action_kind: 'hold', confidence: 80, summary: 'fixture', input_snapshot_id: 'snapshot', content_sha256: contentHash(decision), created_at_utc: now })
  await insert('trade_decision_payloads', { trade_decision_id: 'decision', payload_json: JSON.stringify(decision), payload_sha256: contentHash(decision), payload_bytes: Buffer.byteLength(JSON.stringify(decision)) })
  const evidence = createDecisionStrategyEvidenceReader(db), configs = createStrategyExecutionConfigReader(db)
  const scope = { decisionId: 'decision', decisionRevision: 1, userId: 7, accountId: '5' }
  const candidate = { ...scope, decisionHash: contentHash(decision), policy: { userId: 7, accountId: '5' }, currentRevisions: { subscription: 1 } }
  const read = () => readStrategyBudgetContext(candidate, evidence, configs)
  const baseline = await read(); assert.equal(baseline.strategyRiskCeilingPercent, '1')
  report.executionWindow = await verifyBudgetExecutionWindow(db, snapshot)
  assert.deepEqual(await read(), baseline)
  report.checks.push('actual-current-column-DDL-and-joined-frozen-current-context')
  const sizing = { resolvedTier: 'light', equity: '10000', maxRiskPerTradePercent: '2', strategyRiskCeilingPercent: baseline.strategyRiskCeilingPercent,
    entry: '2500', stopLoss: '2490', tickSize: '0.01', tickValue: '1', volumeMin: '0.01', volumeMax: '10', volumeStep: '0.01', maxOrderVolume: '5' }
  assert.equal(calculatePositionTierVolume(sizing).volume, '0.05')
  assert.equal(positionVolumeExceedsRiskBudget({ ...sizing, resolvedTier: 'standard', volume: '0.11' }), true)
  report.checks.push('SQL-budget-consumed-by-actual-tier-and-explicit-volume-core')
  for (const [label, sql, values] of [
    ['subscription-revision', 'UPDATE strategy_subscriptions SET revision=2', []],
    ['subscription-paused', "UPDATE strategy_subscriptions SET status='paused'", []],
    ['send-disabled', 'UPDATE strategy_subscriptions SET trade_send_enabled=0', []],
    ['owner-revoked', 'UPDATE trading_account_ownerships SET revoked_at_utc=?', [now]],
    ['strategy-retired', "UPDATE strategies SET status='retired'", []],
    ['strategy-owner', 'UPDATE strategies SET owner_user_id=8', []],
    ['active-version', 'UPDATE strategies SET active_version_id=22', []],
    ['config-raised', 'UPDATE strategy_versions SET config_json=?', [JSON.stringify({ risk_budget: { version: 1, max_risk_per_trade_percent: '2' } })]],
    ['prompt-tampered', "UPDATE strategy_versions SET prompt_text='changed'", []],
    ['run-failed', "UPDATE ai_trader_runs SET status='failed'", []],
    ['decision-tampered', 'UPDATE trade_decision_payloads SET payload_json=?', ['{}']],
  ]) {
    await db.beginTransaction()
    try { await db.execute(sql, values); await assert.rejects(read, error => ['risk_strategy_evidence_stale', 'risk_strategy_config_stale'].includes(error.code)) }
    finally { await db.rollback() }
    assert.deepEqual(await read(), baseline); report.checks.push(label + '-rejected-and-rollback-restored')
  }
  other = await mysql.createConnection({ ...options, database: name })
  await other.query("SET SESSION time_zone='+00:00'"); await other.query('SET SESSION innodb_lock_wait_timeout=1')
  await db.beginTransaction(); assert.deepEqual(await read(), baseline)
  await assert.rejects(() => other.query('UPDATE strategy_subscriptions SET revision=2 WHERE id=8'), error => error.code === 'ER_LOCK_WAIT_TIMEOUT')
  await assert.rejects(() => other.execute('UPDATE strategy_versions SET config_json=? WHERE id=21', ['{}']), error => error.code === 'ER_LOCK_WAIT_TIMEOUT')
  await db.commit()
  await other.query('UPDATE strategy_subscriptions SET revision=2 WHERE id=8')
  await assert.rejects(read, error => error.code === 'risk_strategy_config_stale')
  report.checks.push('real-FOR-SHARE-blocks-competing-subscription-write-until-commit-then-stale')
  report.checks.push('real-FOR-SHARE-blocks-competing-config-write')
  report.artifacts = []
  for (const file of ['scripts/verify-strategy-budget-reference-local.mjs', 'scripts/run-strategy-budget-reference-local.py',
    'scripts/lib/budget-execution-window-reference.mjs', 'server/dist-v4/modules/execution/infrastructure/mysql-execution-window.js',
    'server/dist-v4/modules/strategies/infrastructure/mysql-subscription-execution-preferences.js',
    'server/dist-v4/modules/inference/infrastructure/mysql-decision-strategy-evidence-reader.js',
    'server/dist-v4/modules/strategies/infrastructure/mysql-strategy-execution-config-reader.js',
    'server/dist-v4/modules/risk/application/strategy-budget-context.js', 'server/dist-v4/modules/risk/domain/position-tier-sizing.js']) {
    report.artifacts.push({ file, sha256: createHash('sha256').update(await readFile(new URL(file, root))).digest('hex') })
  }
  report.passed = true
} catch (error) {
  report.errorCode = error?.code ?? error?.name ?? 'reference_failed'
  if (error?.code === 'ER_NO_SUCH_TABLE') report.missingTable = /Table '([a-zA-Z0-9_.]+)' doesn't exist/.exec(error.sqlMessage ?? '')?.[1]
  process.exitCode = 1
}
finally {
  if (other) await other.end()
  if (db) { try { await db.rollback(); if (created) { await db.query('DROP DATABASE `' + name + '`'); report.referenceDatabaseRemoved = true }
    if (locked) await db.execute('SELECT RELEASE_LOCK(?)', ['aurum:inplace:dev_vue']) } finally { await db.end() } }
  report.observedAt = new Date().toISOString(); await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.close()
  console.log(JSON.stringify({ passed: report.passed, errorCode: report.errorCode, checks: report.checks.length,
    referenceDatabaseRemoved: report.referenceDatabaseRemoved, existingDatabaseWrites: 0 }))
}
