import { randomUUID } from 'node:crypto'
import type { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import type { SystemReviewContext } from '../application/system-review-context.js'
import type { SystemTradeCaseInput } from '../application/system-trade-case.js'
import { reviewEvidenceHash, verifiedReviewEvidence } from './review-evidence-integrity.js'

/** Completes an immutable evidence revision and queues one model job in the caller's transaction. */
export function createMysqlSystemTradeCaseCompletion(connection: PoolConnection) {
  return { async complete(userId: number, caseId: string, contexts: SystemReviewContext[]) {
    const supplied = structuredClone(contexts)
    const [rows] = await connection.execute<RowDataPacket[]>(`SELECT c.status,c.evidence_status,c.evidence_revision,c.revision,
      e.evidence_sha256,e.evidence_json FROM review_cases_v4 c INNER JOIN review_evidence_payloads_v4 e
        ON e.review_case_id=c.id AND e.evidence_revision=c.evidence_revision
      WHERE c.id=? AND c.user_id=? AND c.kind='trade' AND c.legacy_source_table IS NULL FOR UPDATE`, [caseId,userId])
    if (rows.length !== 1) throw Error('system_review_case_unavailable')
    const row = rows[0]!, frozen = verifiedReviewEvidence(row.evidence_json, row.evidence_sha256)
    const source = frozen.execution as SystemTradeCaseInput['source']
    const trade = frozen.trade as SystemTradeCaseInput['trade']
    if (frozen.source !== 'system_trade' || source?.status !== 'proven' || !Array.isArray(source.proofs)
      || trade?.evidence.userId !== userId) throw Error('system_review_case_corrupt')
    const keys = new Set(source.proofs.map(p => JSON.stringify([p.decisionId,p.riskDecisionId])))
    const seen = new Set<string>()
    if (!keys.size || supplied.length !== keys.size || supplied.length > 1000) throw Error('system_review_context_incomplete')
    for (const c of supplied) {
      const key = JSON.stringify([c.decisionId,c.riskDecisionId]), i = c.inference, r = c.risk
      if (!keys.has(key) || seen.has(key) || i.decisionId !== c.decisionId || r.decisionId !== c.decisionId
        || r.riskDecisionId !== c.riskDecisionId || i.userId !== userId || r.userId !== userId
        || i.accountId !== trade.evidence.accountId || r.accountId !== trade.evidence.accountId
        || i.strategyId !== source.strategyId || i.strategyVersionId !== source.strategyVersionId
        || !i.snapshot || !i.decision || !r.evaluation
        || ![i.decisionHash,i.snapshotHash,r.payloadHash].every(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v))) {
        throw Error('system_review_context_mismatch')
      }
      seen.add(key)
    }
    supplied.sort((a,b) => a.decisionId.localeCompare(b.decisionId) || a.riskDecisionId.localeCompare(b.riskDecisionId))
    const contextHash = reviewEvidenceHash({ contexts: supplied })
    if (row.evidence_status === 'complete') {
      if (frozen.contextHash !== contextHash) throw Error('system_review_context_changed')
      return { status: 'unchanged' as const, caseId }
    }
    if (row.status !== 'awaiting_evidence' || row.evidence_status !== 'incomplete') throw Error('system_review_case_not_waiting')
    const next = { ...frozen, contexts: supplied, contextHash,
      contextCoverage: { terminalTrade: 'complete_as_of', executionLineage: 'exact', analysisContent: 'frozen_trader_input',
        riskContent: 'frozen_evaluation', subscription: 'frozen_run_revision_and_snapshot' } }
    const json = JSON.stringify(next), hash = reviewEvidenceHash(next), evidenceRevision = Number(row.evidence_revision)+1
    await connection.execute(`INSERT INTO review_evidence_payloads_v4
      (review_case_id,evidence_revision,evidence_json,evidence_sha256,payload_bytes,created_at_utc)
      VALUES (?,?,?,?,?,UTC_TIMESTAMP(3))`, [caseId,evidenceRevision,json,hash,Buffer.byteLength(json)])
    for (const c of supplied) {
      for (const [kind,id,sourceHash] of [['trade_decision',c.decisionId,c.inference.decisionHash],['risk_decision',c.riskDecisionId,c.risk.payloadHash]]) {
        await connection.execute(`INSERT INTO review_case_sources_v4
          (review_case_id,source_kind,source_id,relation_kind,source_sha256,source_metadata_json,created_at_utc)
          VALUES (?,?,?,'direct',?,'{}',UTC_TIMESTAMP(3))`, [caseId,String(kind),String(id),String(sourceHash)])
      }
    }
    const [updated] = await connection.execute<ResultSetHeader>(`UPDATE review_cases_v4 SET status='queued',evidence_status='complete',
      evidence_revision=?,evidence_sha256=?,review_eligible_at_utc=UTC_TIMESTAMP(3),updated_at_utc=UTC_TIMESTAMP(3),revision=revision+1
      WHERE id=? AND revision=? AND status='awaiting_evidence'`, [evidenceRevision,hash,caseId,row.revision])
    if (updated.affectedRows !== 1) throw Error('system_review_revision_changed')
    const jobId = randomUUID()
    await connection.execute(`INSERT INTO review_jobs_v4
      (id,review_case_id,generation,mode,status,evidence_revision,input_sha256,progress_percent,current_stage,created_at_utc,updated_at_utc,revision)
      VALUES (?,?,1,'initial','queued',?,?,0,'queued',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),1)`, [jobId,caseId,evidenceRevision,hash])
    await connection.execute(`INSERT INTO review_job_events_v4
      (review_job_id,event_type,from_status,to_status,metadata_json,occurred_at_utc)
      VALUES (?,'review_queued',NULL,'queued','{}',UTC_TIMESTAMP(3))`, [jobId])
    for (const [aggregate,id,type,payload] of [
      ['review_job',jobId,'review.job.requested',{ review_job_id: jobId, review_case_id: caseId, generation: 1 }],
      ['review_case',caseId,'review.case.changed',{ review_case_id: caseId, status: 'queued', current_version_id: null, revision: String(Number(row.revision)+1) }],
    ] as const) {
      await connection.execute(`INSERT INTO outbox_events
        (event_id,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,available_at_utc,created_at_utc)
        VALUES (?,?,?,?,?,'pending',0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`, [randomUUID(),aggregate,id,type,JSON.stringify(payload)])
    }
    return { status: 'queued' as const, caseId, jobId }
  } }
}
