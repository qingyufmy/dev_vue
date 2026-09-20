import { createHash } from 'node:crypto'
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { BridgeGatewayRoute } from '../../bridge/index.js'
import type { TerminalDealFact } from '../domain/terminal-history-projection.js'
import type { SystemTradeSource } from '../application/system-trade-source.js'
import { createReviewTradeReadinessReader, type ReviewTradeReadinessReader } from '../application/review-trade-readiness.js'
import type { ReviewTradeEvidence } from '../application/review-trade-evidence-reader.js'
import { createMysqlSystemReviewTradeEvidenceReader } from './mysql-review-trade-evidence-reader.js'
import { createMysqlHistoryTaskDealInventoryReader } from './mysql-history-task-deal-inventory-reader.js'

interface AttributionPorts {
  source(route: BridgeGatewayRoute, facts: TerminalDealFact[]): Promise<SystemTradeSource>
  authorize(evidence: ReviewTradeEvidence): Promise<boolean>
}

/** Caller owns a short transaction and must roll back on any error, including after record update. */
export function createMysqlSystemTradeAttribution(connection: PoolConnection, ports: AttributionPorts) {
  return { async reconcile(input: Parameters<ReviewTradeReadinessReader['read']>[0]) {
    const scope = structuredClone(input)
    // Lock before reading evidence: concurrent reconcilers cannot upgrade the same revision twice.
    await connection.execute<RowDataPacket[]>(`SELECT id FROM account_trade_records_v4
      WHERE id=? AND user_id=? FOR UPDATE`, [scope.recordId, scope.userId])
    const captured: { source?: Extract<SystemTradeSource, { status: 'proven' }> } = {}
    const evidence = createMysqlSystemReviewTradeEvidenceReader(connection, async facts => {
      const source = await ports.source(scope.route, facts)
      if (source.status !== 'proven') return false
      captured.source = structuredClone(source)
      return true
    })
    const ready = await createReviewTradeReadinessReader(evidence, createMysqlHistoryTaskDealInventoryReader(connection)).read(scope)
    if (ready.status !== 'ready_as_of') return ready
    if (!captured.source || !await ports.authorize(ready.evidence)) return { status: 'unresolved' as const, reason: 'system_trade_ownership_unavailable' }
    const source = captured.source, e = ready.evidence
    const groups = new Map<string, typeof source.proofs>()
    for (const proof of source.proofs) {
      const key = JSON.stringify([proof.commandId, proof.action === 'order.place' ? 'opened' : 'closed'])
      groups.set(key, [...(groups.get(key) ?? []), proof])
    }
    for (const [key, proofs] of groups) {
      const [commandId, relation] = JSON.parse(key) as [string, string]
      const metadata = JSON.stringify({ version: 1, evidenceHash: e.evidenceHash,
        strategyId: source.strategyId, strategyVersionId: source.strategyVersionId,
        proofs: proofs.sort((a, b) => a.dealTicket.localeCompare(b.dealTicket)) })
      const hash = createHash('sha256').update(metadata).digest('hex')
      const [existing] = await connection.execute<RowDataPacket[]>(`SELECT proof_sha256 FROM account_trade_attributions_v4
        WHERE trade_record_id=? AND source_kind='bridge_command' AND source_id=? AND relation_kind=? FOR UPDATE`,
      [e.recordId, commandId, relation])
      if (existing.length) {
        if (existing.length !== 1 || existing[0]!.proof_sha256 !== hash) throw Error('system_trade_attribution_conflict')
        continue
      }
      await connection.execute(`INSERT INTO account_trade_attributions_v4
        (trade_record_id,source_kind,source_id,relation_kind,proof_kind,proof_sha256,metadata_json,created_at_utc)
        VALUES (?,'bridge_command',?,?,'terminal_deal',?,?,UTC_TIMESTAMP(3))`, [e.recordId, commandId, relation, hash, metadata])
    }
    const [updated] = await connection.execute<ResultSetHeader>(`UPDATE account_trade_records_v4
      SET revision=revision+IF(source_classification='system' AND attribution_status='exact',0,1),
        source_classification='system',attribution_status='exact',updated_at_utc=UTC_TIMESTAMP(3)
      WHERE id=? AND user_id=? AND revision=? AND evidence_sha256=? AND source_classification IN ('unknown','system')`,
    [e.recordId, scope.userId, scope.expectedRevision, e.evidenceHash])
    if (updated.affectedRows !== 1) throw Error('system_trade_attribution_revision_changed')
    const [rows] = await connection.execute<RowDataPacket[]>('SELECT revision FROM account_trade_records_v4 WHERE id=?', [e.recordId])
    return { status: 'attributed' as const, recordId: e.recordId, revision: Number(rows[0]!.revision),
      strategyId: source.strategyId, strategyVersionId: source.strategyVersionId,
      taskId: ready.taskId, completionHash: ready.completionHash,
      trade: { ...ready, evidence: { ...e, revision: Number(rows[0]!.revision) } }, source }
  } }
}
