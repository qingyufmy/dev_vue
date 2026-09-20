import { projectReferenceEntryEvidence, freezeReferenceEntryEvidence } from '../../server/dist-v4/modules/inference/application/reference-entry-evidence.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createMysqlTradeDecisionEntryAnalysisReader } from '../../server/dist-v4/modules/inference/composition.js'
import { contentHash } from '../../server/dist-v4/modules/inference/domain/inference.js'
import { compileStrategy } from '../../server/dist-v4/modules/strategies/application/strategy-service.js'

export async function verifyEntryAnalysisReference(connection, analysisStrategyId, analysisVersionId, subscriptionId) {
  const [[identity]] = await connection.query('SELECT DATABASE() db')
  assert.match(identity.db, /^dev_vue_strategy_ref_[a-f0-9]{32}$/)
  const insert = (table, row) => connection.execute(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`, Object.values(row))
  const ids = Object.fromEntries(['analysis', 'analysisRun', 'analysisInput', 'traderRun', 'traderInput', 'decision', 'risk'].map(key => [key, randomUUID()]))
  const at = '2020-01-01 00:00:00.000', digest = 'a'.repeat(64), checks = []
  await connection.beginTransaction()
  try {
    const [strategy] = await insert('strategies', { kind: 'trader', scope: 'platform', name: 'entry history fixture', description: '', status: 'draft', created_at_utc: at, updated_at_utc: at })
    const strategyId = String(strategy.insertId), compiled = compileStrategy('trader', 'entry history fixture', {})
    assert.ok(compiled.valid)
    const [version] = await insert('strategy_versions', { strategy_id: strategyId, version_number: 1, prompt_text: 'entry history fixture',
      prompt_sha256: compiled.promptHash, input_contract_version: compiled.inputContractVersion, output_contract_version: compiled.outputContractVersion,
      config_json: JSON.stringify(compiled.normalizedConfig), created_by_user_id: 7, created_at_utc: at })
    const versionId = String(version.insertId)
    const result = { marketBias: 'bullish', opportunity: 'long_setup', confidence: 80, summary: 'entry', marketRegime: 'trend',
      supportingEvidence: [], counterEvidence: [], dataGaps: [], keyLevels: { accelerationByTimeframe: { H1: true } }, invalidation: {},
      analysisBody: 'frozen entry', analyzedAt: '2020-01-01T00:01:00.000Z', validUntil: '2020-01-01T00:10:00.000Z' }
    const analysisInput = { kind: 'analysis', strategy: { id: String(analysisStrategyId), versionId: String(analysisVersionId) }, market: { symbol: 'XAUUSD' }, capturedAt: '2020-01-01T00:00:00.000Z' }
    const traderInput = { kind: 'trader', strategy: { id: strategyId, versionId }, account: { id: '5' }, capturedAt: '2020-01-01T00:02:00.000Z',
      analysis: { id: ids.analysis, contentHash: contentHash(result), result } }
    for (const [id, payload] of [[ids.analysisInput, analysisInput], [ids.traderInput, traderInput]]) {
      await insert('inference_snapshots', { id, purpose: payload.kind, user_id: 7, trading_account_id: payload.kind === 'analysis' ? null : '5',
        strategy_id: payload.strategy.id, strategy_version_id: payload.strategy.versionId, standard_symbol: 'XAUUSD',
        payload_sha256: contentHash(payload), payload_bytes: Buffer.byteLength(JSON.stringify(payload)), captured_at_utc: new Date(payload.capturedAt), created_at_utc: at })
      await insert('inference_snapshot_payloads', { snapshot_id: id, encoding: 'json', payload_json: JSON.stringify(payload) })
    }
    await insert('ai_analysis_runs', { id: ids.analysisRun, user_id: 7, strategy_id: analysisStrategyId, strategy_version_id: analysisVersionId,
      standard_symbol: 'XAUUSD', trigger_type: 'manual', idempotency_key: ids.analysisRun, input_snapshot_id: ids.analysisInput,
      status: 'succeeded', created_at_utc: at, updated_at_utc: at })
    await insert('market_analyses', { id: ids.analysis, analysis_run_id: ids.analysisRun, owner_scope: 'user', owner_user_id: 7,
      strategy_id: analysisStrategyId, strategy_version_id: analysisVersionId, standard_symbol: 'XAUUSD', market_bias: result.marketBias,
      opportunity: result.opportunity, confidence: 80, summary: 'entry', input_snapshot_id: ids.analysisInput, content_sha256: contentHash(result),
      analyzed_at_utc: new Date(result.analyzedAt), valid_until_utc: new Date(result.validUntil), created_at_utc: at })
    await insert('market_analysis_payloads', { market_analysis_id: ids.analysis, payload_json: JSON.stringify(result), payload_sha256: contentHash(result), payload_bytes: Buffer.byteLength(JSON.stringify(result)) })
    await insert('ai_trader_runs', { id: ids.traderRun, user_id: 7, trading_account_id: '5', subscription_id: subscriptionId, subscription_revision: 1,
      market_analysis_id: ids.analysis, strategy_id: strategyId, strategy_version_id: versionId, idempotency_key: ids.traderRun,
      input_snapshot_id: ids.traderInput, task_mode: 'entry', status: 'succeeded', created_at_utc: at, updated_at_utc: at })
    await insert('trade_decisions', { id: ids.decision, trader_run_id: ids.traderRun, user_id: 7, trading_account_id: '5', market_analysis_id: ids.analysis,
      strategy_id: strategyId, strategy_version_id: versionId, action_kind: 'market_order', side: 'buy', confidence: 80, summary: 'entry',
      input_snapshot_id: ids.traderInput, content_sha256: digest, status: 'accepted', created_at_utc: at })
    const [[policy]] = await connection.query('SELECT id FROM risk_policy_versions_v4 ORDER BY id LIMIT 1')
    await insert('risk_decisions_v4', { id: ids.risk, trade_decision_id: ids.decision, user_id: 7, trading_account_id: '5', platform_policy_version_id: policy.id,
      policy_set_revision: 1, account_risk_revision: 1, decision_status: 'approved', policy_sha256: digest, created_at_utc: at })
    await connection.execute('UPDATE trade_decisions SET risk_decision_id=? WHERE id=?', [ids.risk, ids.decision])
    const scope = { decisionId: ids.decision, riskDecisionId: ids.risk, userId: 7, accountId: '5', strategyId, strategyVersionId: versionId, symbol: 'XAUUSD' }
    const reader = createMysqlTradeDecisionEntryAnalysisReader(connection), healthy = await reader.read(scope)
    assert.ok(healthy); assert.deepEqual(healthy.result, result)
    assert.equal(healthy.inputSnapshotId, ids.analysisInput); assert.equal(healthy.traderInputSnapshotId, ids.traderInput)
    checks.push('full-ddl-three-payload-lineage-distinct-strategy-versions-expired-history-readable')
    const modelEvidence=freezeReferenceEntryEvidence(projectReferenceEntryEvidence({referenceId:'position:fixture',userId:7,accountId:'5',strategyId,symbol:'XAUUSD',asOf:'2026-09-10T00:00:00.000Z',
      creationDecisions:[{orderTicket:'fixture-private-order',decisionId:ids.decision,riskDecisionId:ids.risk,strategyVersionId:versionId}],
      evidence:{ticket:'fixture-private-ticket',status:'read',entries:[{orderTicket:'fixture-private-order',analysis:healthy}]}}))
    assert.equal(modelEvidence.state,'ready');assert.equal(modelEvidence.purpose,'creation_analysis_only')
    assert.deepEqual(modelEvidence.entries[0].keyLevels,result.keyLevels)
    for(const privateId of [ids.decision,ids.risk,ids.analysisInput,ids.traderInput,'fixture-private-order','fixture-private-ticket'])assert.ok(!JSON.stringify(modelEvidence).includes(privateId))
    checks.push('real-historical-analysis-to-bounded-model-evidence-without-private-identifiers')
    const patches = [
      ['account', 'UPDATE trade_decisions SET user_id=7 WHERE id=?', [ids.decision], { ...scope, accountId: '6' }],
      ['version', 'UPDATE trade_decisions SET user_id=7 WHERE id=?', [ids.decision], { ...scope, strategyVersionId: String(BigInt(versionId) + 1n) }],
      ['analysis-digest', "UPDATE market_analysis_payloads SET payload_sha256=REPEAT('0',64) WHERE market_analysis_id=?", [ids.analysis]],
      ['input-digest', "UPDATE inference_snapshots SET payload_sha256=REPEAT('0',64) WHERE id=?", [ids.analysisInput]],
      ['trader-digest', "UPDATE inference_snapshots SET payload_sha256=REPEAT('0',64) WHERE id=?", [ids.traderInput]],
      ['run-state', "UPDATE ai_analysis_runs SET status='running' WHERE id=?", [ids.analysisRun]],
    ]
    for (const [name, sql, parameters, request = scope] of patches) {
      await connection.query('SAVEPOINT entry_patch')
      try { await connection.execute(sql, parameters); assert.equal(await reader.read(request), null); checks.push(name) }
      finally { await connection.query('ROLLBACK TO SAVEPOINT entry_patch') }
    }
    const changed = structuredClone(traderInput); changed.analysis.result.summary = 'different'
    await connection.execute('UPDATE inference_snapshot_payloads SET payload_json=? WHERE snapshot_id=?', [JSON.stringify(changed), ids.traderInput])
    await connection.execute('UPDATE inference_snapshots SET payload_sha256=? WHERE id=?', [contentHash(changed), ids.traderInput])
    assert.equal(await reader.read(scope), null); checks.push('rehash-cannot-replace-trader-pinned-analysis')
    return { passed: true, checks, schema: 'actual-inference-migrations-with-foreign-keys', parentScope: 'reference-users-accounts-and-subscription',
      modelEntryEvidenceVerified: true, existingDatabaseWrites: 0, fixtureWritesRolledBack: true, runtimeActivationVerified: false }
  } finally { await connection.rollback() }
}
