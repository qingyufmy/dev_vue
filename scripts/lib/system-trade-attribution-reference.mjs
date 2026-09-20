import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { splitSqlStatements } from './v4-migration-plan.mjs'
import { createMysqlSystemTradeAttribution } from '../../server/dist-v4/modules/trade-history/composition.js'
import { createMysqlSystemTradeCaseWriter, createMysqlSystemTradeCaseCompletion } from '../../server/dist-v4/modules/reviews/composition.js'

/** Actual history inventory and SQL writes; source and ownership ports are explicitly synthetic. */
export async function verifySystemTradeAttribution(pool, scope, asOfUtcMsc) {
  const c = await pool.getConnection()
  let destroyed = false
  try {
    const [[db]] = await c.query('SELECT DATABASE() db')
    assert.match(db.db, /^dev_vue_history_ref_[a-f0-9]{32}$/)
    const ddl = await readFile(new URL('../../server/db/migrations/20260904_013_authoritative_trade_history.sql', import.meta.url), 'utf8')
    const table = splitSqlStatements(ddl).filter(sql => /CREATE TABLE IF NOT EXISTS account_trade_attributions_v4\s*\(/.test(sql))
    assert.equal(table.length, 1)
    await c.query(table[0])
    await c.query("ALTER TABLE review_cases_v4 MODIFY COLUMN kind ENUM('daily','monthly','manual','trade') NOT NULL")
    await c.beginTransaction()
    const [[before]] = await c.execute('SELECT revision,source_classification FROM account_trade_records_v4 WHERE id=? FOR UPDATE', [scope.recordId])
    assert.equal(before.source_classification, 'manual')
    await c.execute("UPDATE account_trade_records_v4 SET source_classification='unknown',attribution_status='unresolved' WHERE id=?", [scope.recordId])
    let authorized = false, altered = false
    const writer = createMysqlSystemTradeAttribution(c, {
      async source(_route, facts) {
        return { status: 'proven', strategyId: '1', strategyVersionId: '1', proofs: facts.map(f => ({
          dealTicket: f.ticket, orderTicket: f.orderTicket, commandId: `reference-${f.ticket}`, intentId: altered ? 'altered' : `intent-${f.ticket}`,
          action: f.entryKind === 'in' ? 'order.place' : 'position.close', resultHash: 'a'.repeat(64),
          decisionId: 'decision', riskDecisionId: 'risk', strategyId: '1', strategyVersionId: '1',
        })) }
      },
      async authorize() { return authorized },
    })
    const input = { userId: scope.userId, recordId: scope.recordId, expectedRevision: Number(before.revision),
      taskId: scope.taskId, route: scope.route, asOfUtcMsc }
    assert.equal((await writer.reconcile(input)).reason, 'system_trade_ownership_unavailable')
    const [[empty]] = await c.query('SELECT COUNT(*) n FROM account_trade_attributions_v4')
    assert.equal(Number(empty.n), 0)
    authorized = true
    const first = await writer.reconcile(input)
    assert.equal(first.status, 'attributed')
    assert.equal(first.revision, input.expectedRevision + 1)
    const replay = await writer.reconcile({ ...input, expectedRevision: first.revision })
    assert.equal(replay.revision, first.revision)
    const [[count]] = await c.query('SELECT COUNT(*) n FROM account_trade_attributions_v4')
    assert.equal(Number(count.n), 2)
    await c.execute("UPDATE strategies SET kind='trader' WHERE id=1")
    const cases = createMysqlSystemTradeCaseWriter(c)
    const created = await cases.create({ trade: first.trade, source: first.source })
    assert.equal(created.status, 'created')
    const replayCase = await cases.create({ trade: { ...replay.trade, taskId: 'another-completed-task' }, source: replay.source })
    assert.equal(replayCase.status, 'unchanged')
    assert.equal(replayCase.caseId, created.caseId)
    const [[caseRow]] = await c.execute('SELECT status,evidence_status,trader_strategy_version_id FROM review_cases_v4 WHERE id=?', [created.caseId])
    assert.equal(caseRow.status, 'awaiting_evidence')
    assert.equal(caseRow.evidence_status, 'incomplete')
    assert.equal(String(caseRow.trader_strategy_version_id), '1')
    const [[jobs]] = await c.execute('SELECT COUNT(*) n FROM review_jobs_v4 WHERE review_case_id=?', [created.caseId])
    assert.equal(Number(jobs.n), 0)
    const changedCase = structuredClone(first.source); changedCase.proofs[0].intentId = 'changed'
    await assert.rejects(cases.create({ trade: first.trade, source: changedCase }), /system_review_source_changed/)
    const completion = createMysqlSystemTradeCaseCompletion(c)
    const context = { decisionId: 'decision', riskDecisionId: 'risk',
      inference: { decisionId: 'decision', userId: scope.userId, accountId: scope.route.accountId, strategyId: '1', strategyVersionId: '1',
        snapshot: { historical: true }, decision: { historical: true }, decisionHash: 'b'.repeat(64), snapshotHash: 'c'.repeat(64) },
      risk: { decisionId: 'decision', riskDecisionId: 'risk', userId: scope.userId, accountId: scope.route.accountId,
        evaluation: { historical: true }, payloadHash: 'd'.repeat(64) } }
    await assert.rejects(completion.complete(scope.userId, created.caseId, []), /system_review_context_incomplete/)
    const queued = await completion.complete(scope.userId, created.caseId, [context])
    assert.equal(queued.status, 'queued')
    assert.equal((await completion.complete(scope.userId, created.caseId, [context])).status, 'unchanged')
    const [[completed]] = await c.execute(`SELECT c.evidence_revision,c.status,
      (SELECT COUNT(*) FROM review_jobs_v4 j WHERE j.review_case_id=c.id) jobs,
      (SELECT COUNT(*) FROM review_evidence_payloads_v4 e WHERE e.review_case_id=c.id) versions
      FROM review_cases_v4 c WHERE c.id=?`, [created.caseId])
    assert.equal(Number(completed.jobs), 1); assert.equal(Number(completed.versions), 2)
    assert.equal(Number(completed.evidence_revision), 2); assert.equal(completed.status, 'queued')
    const different = structuredClone(context); different.inference.decisionHash = 'e'.repeat(64)
    await assert.rejects(completion.complete(scope.userId, created.caseId, [different]), /system_review_context_changed/)
    altered = true
    await assert.rejects(writer.reconcile({ ...input, expectedRevision: first.revision }), /system_trade_attribution_conflict/)
    await c.rollback()
    const [[restored]] = await c.execute('SELECT revision,source_classification FROM account_trade_records_v4 WHERE id=?', [scope.recordId])
    assert.deepEqual(restored, before)
    const [[rolledBack]] = await c.query('SELECT COUNT(*) n FROM account_trade_attributions_v4')
    assert.equal(Number(rolledBack.n), 0)
    const [[rolledBackCase]] = await c.execute('SELECT COUNT(*) n FROM review_cases_v4 WHERE id=?', [created.caseId])
    assert.equal(Number(rolledBackCase.n), 0)
    return { passed: true, historyInventory: 'actual-completed-task', sql: 'actual-mysql', sourcePort: 'synthetic', ownershipPort: 'synthetic',
      checks: ['ownership-rejection-zero-writes', 'unknown-to-system-with-two-proofs', 'replay-no-revision-or-proof-growth', 'conflict-preserves-proof', 'rollback-restores-record-and-removes-proofs',
        'system-case-freezes-trader-version', 'new-task-replays-one-case', 'missing-context-does-not-enqueue-model', 'changed-case-proof-rejected', 'case-and-attribution-rollback-together',
        'complete-context-appends-frozen-revision-and-one-job', 'context-replay-no-extra-job-or-version', 'changed-context-rejected'] }
  } catch (error) {
    try { await c.rollback() } catch { destroyed = true; c.destroy() }
    throw error
  } finally { if (!destroyed) c.release() }
}
