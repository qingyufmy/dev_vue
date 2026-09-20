import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { splitSqlStatements } from './v4-migration-plan.mjs'
import { createMysqlPendingOrderOriginReader, createMysqlSnapshotPendingOrderOriginReader, createMysqlSnapshotOpeningOrderOriginReader } from '../../server/dist-v4/modules/execution/composition.js'
import { createTransactionTradeDecisionOriginReader, createMysqlSnapshotTradeDecisionOriginReader } from '../../server/dist-v4/modules/inference/composition.js'

// Selected migration-derived session-local tables verify query behavior, not FKs.
export async function verifyPendingOriginReference(connection, report, inspectSeededOrigins) {
  const [[identity]] = await connection.query('SELECT DATABASE() db')
  assert.match(identity.db, /^dev_vue_strategy_ref_[a-f0-9]{32}$/)
  const tables = ['execution_intents', 'bridge_commands_v4', 'execution_distributions', 'execution_distribution_targets', 'execution_outcomes']
  const result = { passed: false, checks: [], temporaryTablesRemoved: false, foreignKeysVerified: false,
    inferenceOriginReader: 'actual_mysql_adapter', sources: [], inferenceTableDefinitions: [] }
  report.pendingOrigins = result
  const statements = []
  for (const file of ['20260903_009_execution_intents_and_reservations.sql', '20260903_010_bridge_v4_command_ledger.sql',
    '20260904_011_user_execution_commands_and_distributions.sql']) {
    const sql = await readFile(new URL('../../server/db/migrations/' + file, import.meta.url), 'utf8')
    result.sources.push({ file, sha256: createHash('sha256').update(sql).digest('hex') })
    statements.push(...splitSqlStatements(sql))
  }
  const created = []
  try {
    for (const table of tables) {
      const source = statements.find(sql => sql.startsWith(`CREATE TABLE IF NOT EXISTS ${table} (`))
      assert.ok(source)
      const ddl = source.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TEMPORARY TABLE')
        .split('\n').filter(line => !line.includes('FOREIGN KEY')).join('\n').replace(/,\s*\)/g, ')')
      await connection.query(ddl); created.push(table)
    }
    const alter = statements.find(sql => sql.startsWith('ALTER TABLE execution_intents\n'))
    assert.ok(alter)
    await connection.query(alter.split('\n').filter(line => !line.includes('FOREIGN KEY')).join('\n'))
    for (const table of ['ai_trader_runs', 'trade_decisions']) {
      const [[definition]] = await connection.query(`SHOW CREATE TABLE ${table}`)
      const source = definition['Create Table']
      result.inferenceTableDefinitions.push({ table, sha256: createHash('sha256').update(source).digest('hex') })
      const ddl = source.replace(/^CREATE TABLE/, 'CREATE TEMPORARY TABLE')
        .split('\n').filter(line => !line.includes('FOREIGN KEY')).join('\n').replace(/,\s*\)/g, ')')
      await connection.query(ddl); created.push(table)
    }
    await connection.beginTransaction()
    const now = '2026-09-09 00:00:00.000', digest = 'a'.repeat(64)
    const insert = (table, row) => connection.execute(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`, Object.values(row))
    await insert('ai_trader_runs', { id: 'trader-origin-1', user_id: 7, trading_account_id: '11', subscription_id: '1', subscription_revision: 1,
      market_analysis_id: 'analysis-origin-1', strategy_id: '21', strategy_version_id: '31', idempotency_key: 'trader-origin-1',
      input_snapshot_id: 'snapshot-origin-1', task_mode: 'entry', status: 'succeeded', created_at_utc: now, updated_at_utc: now })
    await insert('trade_decisions', { id: 'decision-1', trader_run_id: 'trader-origin-1', user_id: 7, trading_account_id: '11',
      market_analysis_id: 'analysis-origin-1', strategy_id: '21', strategy_version_id: '31', action_kind: 'pending_order', side: 'buy',
      confidence: 80, summary: 'fixture', input_snapshot_id: 'snapshot-origin-1', content_sha256: digest,
      status: 'accepted', risk_decision_id: 'risk-1', created_at_utc: now })
    const seed = async (suffix, sourceType, sourceId, ticket, distributionTargetId = null) => {
      await insert('execution_intents', { id: `intent-${suffix}`, operation_id: `operation-${suffix}`,
        risk_decision_id: sourceType === 'risk_decision' ? sourceId : null, trade_decision_id: sourceType === 'risk_decision' ? 'decision-1' : null,
        user_command_id: sourceType === 'risk_decision' ? null : `user-command-${suffix}`, risk_decision_revision: 1, account_risk_revision: 1,
        user_id: 7, trading_account_id: '11', action_id: `action-${suffix}`, action_kind: 'pending_order', source_type: sourceType, source_id: sourceId,
        idempotency_key: suffix.padStart(64, '0'), request_sha256: digest, expected_state_sha256: digest, status: 'succeeded',
        expires_at_utc: now, created_at_utc: now, updated_at_utc: now })
      await insert('bridge_commands_v4', { id: `command-${suffix}`, execution_intent_id: `intent-${suffix}`, command_sequence: 1,
        user_id: 7, trading_account_id: '11', terminal_profile_id: 'profile-1', terminal_instance_id: 'terminal-1', broker_server: 'Broker-Demo',
        account_login: '00123', connection_epoch: 2, action: 'order.place', idempotency_key: `command-${suffix}`, request_sha256: digest,
        status: 'succeeded', issued_at_utc: now, deadline_at_utc: now, result_sha256: digest, created_at_utc: now, updated_at_utc: now })
      await insert('execution_outcomes', { id: `outcome-${suffix}`, execution_intent_id: `intent-${suffix}`, distribution_target_id: distributionTargetId,
        trading_account_id: '11', resource_kind: 'position', ticket: '81', result_sha256: digest, status: 'succeeded',
        result_json: JSON.stringify({ position_ticket: '81', order_ticket: ticket }), created_at_utc: now, updated_at_utc: now })
    }
    await seed('1', 'risk_decision', 'risk-1', '91')
    const scope = { userId: 7, accountId: '11', terminalInstanceId: 'terminal-1', brokerServer: 'Broker-Demo', login: '00123', connectionEpoch: '3', tickets: ['91'] }
    const reader = createMysqlPendingOrderOriginReader(connection, createTransactionTradeDecisionOriginReader(connection))
    const expected = [{ ticket: '91', status: 'strategy', userId: 7, accountId: '11', strategyId: '21' }]
    assert.deepEqual(await reader.read(scope), expected)
    // Only session-local fixtures are committed; no existing database records are changed.
    await connection.commit()
    const snapshotReader = createMysqlSnapshotPendingOrderOriginReader(connection, createMysqlSnapshotTradeDecisionOriginReader(connection))
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
    try {
      assert.deepEqual(await snapshotReader.read(scope), expected)
      assert.deepEqual(await snapshotReader.read({ ...scope, userId: 8 }), [{ ticket: '91', status: 'unresolved' }])
    } finally { await connection.rollback() }
    result.checks.push('actual-snapshot-read-only-creation-lineage-and-scope-denial')
    await connection.beginTransaction()
    result.checks.push('raw-order-ticket-and-historical-command-epoch-resolve-through-public-port')
    for (const sql of ["UPDATE trade_decisions SET risk_decision_id='other-risk'", "UPDATE trade_decisions SET status='proposed'",
      "UPDATE ai_trader_runs SET status='failed'", "UPDATE ai_trader_runs SET user_id=8", "UPDATE ai_trader_runs SET trading_account_id=12",
      "UPDATE ai_trader_runs SET strategy_id=22", "UPDATE ai_trader_runs SET strategy_version_id=32",
      "UPDATE ai_trader_runs SET market_analysis_id='other-analysis'", "UPDATE ai_trader_runs SET input_snapshot_id='other-snapshot'"]) {
      await connection.query('SAVEPOINT inference_origin_mutation')
      try {
        await connection.query(sql)
        await assert.rejects(reader.read(scope), { code: 'execution_dedup_origin_invalid' })
      } finally { await connection.query('ROLLBACK TO SAVEPOINT inference_origin_mutation') }
    }
    result.checks.push('actual-inference-origin-rejects-status-risk-and-run-scope-mismatches')
    for (const patch of [{ userId: 8 }, { accountId: '12' }, { terminalInstanceId: 'terminal-2' }, { brokerServer: 'broker-demo' },
      { login: '123' }, { connectionEpoch: '1' }, { tickets: ['81'] }]) {
      const request = { ...scope, ...patch }
      assert.deepEqual(await reader.read(request), request.tickets.map(ticket => ({ ticket, status: 'unresolved' })))
    }
    result.checks.push('user-account-terminal-case-login-and-epoch-boundaries')
    for (const sql of ["UPDATE execution_intents SET status='uncertain'", "UPDATE bridge_commands_v4 SET status='accepted'",
      "UPDATE execution_outcomes SET status='uncertain'", "UPDATE execution_outcomes SET trading_account_id=12",
      "UPDATE bridge_commands_v4 SET result_sha256=REPEAT('b',64)"]) {
      await connection.query('SAVEPOINT origin_mutation')
      try { await connection.query(sql); assert.deepEqual(await reader.read(scope), [{ ticket: '91', status: 'unresolved' }]) }
      finally { await connection.query('ROLLBACK TO SAVEPOINT origin_mutation') }
    }
    result.checks.push('unsuccessful-or-disconnected-result-evidence-is-not-attributed')
    await insert('execution_distributions', { id: 'distribution-2', parent_operation_id: 'parent-2', actor_user_id: 7, strategy_id: '22',
      strategy_version_id: '32', kind: 'manual_order', idempotency_key: 'distribution-2', request_sha256: digest, command_json: '{}',
      status: 'succeeded', target_count: 1, result_summary_json: '{}', created_at_utc: now, updated_at_utc: now })
    await insert('execution_distribution_targets', { id: 'target-2', distribution_id: 'distribution-2', target_user_id: 7, trading_account_id: '11',
      child_operation_id: 'operation-2', request_sha256: digest, frozen_context_json: '{}', status: 'succeeded', created_at_utc: now, updated_at_utc: now })
    await seed('2', 'strategy_distribution', 'target-2', '92', 'target-2')
    const request = { ...scope, tickets: ['92'] }
    assert.deepEqual(await reader.read(request), [{ ticket: '92', status: 'strategy', userId: 7, accountId: '11', strategyId: '22' }])
    await connection.query('SAVEPOINT distribution_mutation')
    try {
      await connection.query("UPDATE execution_distribution_targets SET child_operation_id='wrong' WHERE id='target-2'")
      await assert.rejects(reader.read(request), { code: 'execution_dedup_origin_invalid' })
    } finally { await connection.query('ROLLBACK TO SAVEPOINT distribution_mutation') }
    result.checks.push('distribution-strategy-requires-exact-target-and-child-operation-chain')
    await seed('3', 'user_command', 'user-command-3', '91')
    await assert.rejects(reader.read(scope), { code: 'execution_dedup_origin_ambiguous' })
    result.checks.push('mixed-creation-evidence-rejected-on-real-query')
    await connection.commit()
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
    try {
      await assert.rejects(snapshotReader.read(scope), { code: 'execution_dedup_origin_ambiguous' })
      assert.deepEqual(await snapshotReader.read(request), [{ ticket: '92', status: 'strategy', userId: 7, accountId: '11', strategyId: '22' }])
    } finally { await connection.rollback() }
    result.checks.push('snapshot-distribution-origin-and-mixed-creation-denial')
    await connection.beginTransaction()
    try {
      await seed('4','risk_decision','risk-1','94')
      await connection.query("UPDATE execution_intents SET action_kind='market_order' WHERE id='intent-4'")
      await connection.query("UPDATE trade_decisions SET action_kind='market_order' WHERE id='decision-1'")
      const openingReader=createMysqlSnapshotOpeningOrderOriginReader(connection,createMysqlSnapshotTradeDecisionOriginReader(connection))
      const openingScope={...scope,tickets:['94']}
      assert.deepEqual(await openingReader.read(openingScope),[{ticket:'94',status:'strategy',userId:7,accountId:'11',strategyId:'21',decisionOrigin:{decisionId:'decision-1',riskDecisionId:'risk-1',strategyVersionId:'31'}}])
      assert.deepEqual(await snapshotReader.read(openingScope),[{ticket:'94',status:'unresolved'}])
      await connection.query('SAVEPOINT opening_decision_lineage')
      await insert('ai_trader_runs', { id:'trader-origin-2',user_id:7,trading_account_id:'11',subscription_id:'1',subscription_revision:2,
        market_analysis_id:'analysis-origin-1',strategy_id:'21',strategy_version_id:'31',idempotency_key:'trader-origin-2',
        input_snapshot_id:'snapshot-origin-1',task_mode:'entry',status:'succeeded',created_at_utc:now,updated_at_utc:now })
      await insert('trade_decisions', { id:'decision-2',trader_run_id:'trader-origin-2',user_id:7,trading_account_id:'11',
        market_analysis_id:'analysis-origin-1',strategy_id:'21',strategy_version_id:'31',action_kind:'market_order',side:'buy',
        confidence:80,summary:'fixture',input_snapshot_id:'snapshot-origin-1',content_sha256:digest,status:'accepted',risk_decision_id:'risk-2',created_at_utc:now })
      await seed('5','risk_decision','risk-2','94')
      await connection.query("UPDATE execution_intents SET action_kind='market_order',trade_decision_id='decision-2' WHERE id='intent-5'")
      await assert.rejects(openingReader.read(openingScope),{code:'opening_order_decision_origin_ambiguous'})
      await connection.query('ROLLBACK TO SAVEPOINT opening_decision_lineage')
      result.checks.push('exact-opening-decision-and-version-retained-conflicting-same-strategy-decision-rejected')
      result.openingDecisionLineageVerified=true
      await connection.execute('UPDATE execution_outcomes SET result_json=? WHERE id=?',[JSON.stringify({ticket:'94',position_ticket:'94',position_id:'94'}),'outcome-4'])
      assert.deepEqual(await openingReader.read(openingScope),[{ticket:'94',status:'unresolved'}])
      await connection.execute('UPDATE execution_outcomes SET result_json=? WHERE id=?',[JSON.stringify({order_ticket:'94',order:'95'}),'outcome-4'])
      await assert.rejects(openingReader.read(openingScope),{code:'opening_order_origin_ticket_ambiguous'})
      result.checks.push('market-order-creation-through-real-inference-lineage-without-position-ticket-confusion')
      result.openingOrderOriginVerified=true
    } finally {await connection.rollback()}
    if (inspectSeededOrigins) await inspectSeededOrigins()
    result.passed = true
  } finally {
    await connection.rollback()
    for (const table of created.reverse()) await connection.query(`DROP TEMPORARY TABLE ${table}`)
    result.temporaryTablesRemoved = true
  }
  return result
}
