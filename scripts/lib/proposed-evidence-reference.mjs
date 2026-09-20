import assert from 'node:assert/strict'
import { createTransactionProposedDecisionEvidenceReader } from '../../server/dist-v4/modules/inference/composition.js'
import { contentHash } from '../../server/dist-v4/modules/inference/index.js'

// Caller owns connection cleanup; every write is scoped to session-local temporary tables.
export async function verifyProposedEvidenceReference(connection) {
  const checks = []
  const tables = ['trade_decisions', 'trade_decision_payloads', 'ai_trader_runs', 'market_analyses',
    'ai_analysis_runs', 'inference_snapshots', 'inference_snapshot_payloads']
  // Build session-local shadows from current DDL; foreign keys cannot reference permanent data in this fixture.
  for (const table of tables) {

    const [[definition]] = await connection.query(`SHOW CREATE TABLE ${table}`)
    const ddl = definition['Create Table'].replace(/^CREATE TABLE/, 'CREATE TEMPORARY TABLE')
      .split('\n').filter(line => !line.includes('FOREIGN KEY')).join('\n').replace(/,\n\)/g, '\n)')
    await connection.query(ddl)
  }
  await connection.beginTransaction()

  const insert = async (table, row) => connection.execute(
    `INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`, Object.values(row))
  const now = '2026-09-09 00:00:00.000'
  const decision = { confidence: 80, action: 'hold', actions: [] }
  const snapshot = { kind: 'analysis', strategy: { id: '1', versionId: '11' },
    market: { symbol: 'XAUUSD' }, capturedAt: '2026-09-09T00:00:00.000Z' }
  const strategy = { strategy_id: '1', strategy_version_id: '11' }
  const run = { user_id: 7, ...strategy, status: 'succeeded', created_at_utc: now, updated_at_utc: now, idempotency_key: 'fixture' }
  await insert('inference_snapshots', { id: 'snapshot-1', purpose: 'analysis', user_id: 7, ...strategy,
    standard_symbol: 'XAUUSD', payload_sha256: contentHash(snapshot), payload_bytes: Buffer.byteLength(JSON.stringify(snapshot)), captured_at_utc: now, created_at_utc: now })
  await insert('inference_snapshot_payloads', { snapshot_id: 'snapshot-1', payload_json: JSON.stringify(snapshot) })
  await insert('ai_analysis_runs', { ...run, id: 'analysis-run-1', standard_symbol: 'XAUUSD', trigger_type: 'manual', input_snapshot_id: 'snapshot-1' })
  await insert('market_analyses', { id: 'analysis-1', analysis_run_id: 'analysis-run-1', owner_scope: 'user', owner_user_id: 7,
    ...strategy, standard_symbol: 'XAUUSD', market_bias: 'neutral', opportunity: 'none', confidence: 80, summary: 'fixture',
    input_snapshot_id: 'snapshot-1', content_sha256: '0'.repeat(64), analyzed_at_utc: now, valid_until_utc: '2026-09-10 00:00:00.000', revision: 2, created_at_utc: now })
  await insert('ai_trader_runs', { ...run, id: 'trader-run-1', trading_account_id: '5', subscription_id: '1', subscription_revision: 1,
    market_analysis_id: 'analysis-1', input_snapshot_id: 'trader-snapshot-1', task_mode: 'entry', analysis_revision: 2 })
  await insert('trade_decisions', { id: 'decision-1', trader_run_id: 'trader-run-1', user_id: 7, trading_account_id: '5',
    market_analysis_id: 'analysis-1', ...strategy, action_kind: 'hold', confidence: 80, summary: 'fixture',
    input_snapshot_id: 'trader-snapshot-1', content_sha256: contentHash(decision), created_at_utc: now })
  await insert('trade_decision_payloads', { trade_decision_id: 'decision-1', payload_json: JSON.stringify(decision),
    payload_sha256: contentHash(decision), payload_bytes: Buffer.byteLength(JSON.stringify(decision)) })
  const reader = createTransactionProposedDecisionEvidenceReader(connection)

  const scope = { decisionId: 'decision-1', decisionRevision: 1, userId: 7, accountId: '5', analysisRevision: 2 }
  assert.equal((await reader.read(scope))?.snapshotHash, contentHash(snapshot))
  checks.push('valid-current-schema-query')
  for (const overrides of [{ userId: 8 }, { accountId: '6' }, { decisionRevision: 2 }, { analysisRevision: 1 }]) {
    assert.equal(await reader.read({ ...scope, ...overrides }), null)
  }
  checks.push('scope-and-revisions-rejected')
  const rejectMutation = async (name, sql, args) => {
    await connection.query('SAVEPOINT evidence_case')
    await connection.execute(sql, args)
    assert.equal(await reader.read(scope), null, name)
    await connection.query('ROLLBACK TO SAVEPOINT evidence_case')
    checks.push(name)
  }
  await rejectMutation('trader-analysis-revision-mismatch', 'UPDATE ai_trader_runs SET analysis_revision=?', [1])
  await rejectMutation('trader-account-mismatch', 'UPDATE ai_trader_runs SET trading_account_id=?', ['6'])
  await rejectMutation('analysis-run-failed', 'UPDATE ai_analysis_runs SET status=?', ['failed'])
  await rejectMutation('case-sensitive-symbol', 'UPDATE ai_analysis_runs SET standard_symbol=?', ['xauusd'])
  await rejectMutation('accepted-decision-denied', 'UPDATE trade_decisions SET status=?', ['accepted'])
  await rejectMutation('risk-reference-denied', 'UPDATE trade_decisions SET risk_decision_id=?', ['risk-1'])
  await rejectMutation('decision-payload-tampered', 'UPDATE trade_decision_payloads SET payload_json=?', [JSON.stringify({ ...decision, confidence: 70 })])
  await rejectMutation('snapshot-payload-tampered', 'UPDATE inference_snapshot_payloads SET payload_json=?', [JSON.stringify({ ...snapshot, capturedAt: '2026-09-08T00:00:00.000Z' })])
  await connection.rollback()
  for (const table of tables) {
    const [[row]] = await connection.query(`SELECT COUNT(*) n FROM ${table}`)
    assert.equal(Number(row.n), 0)
    await connection.query(`DROP TEMPORARY TABLE ${table}`)
  }
  checks.push('fixtures-rolled-back-and-temporary-tables-dropped')
  return { checks, temporaryTablesRemoved: true, foreignKeysVerified: false }
}
