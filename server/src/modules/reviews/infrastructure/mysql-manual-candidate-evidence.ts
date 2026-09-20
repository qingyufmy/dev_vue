import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { ReviewError } from '../domain/review.js'
import { verifiedReviewEvidence } from './review-evidence-integrity.js'
import { reviewIsoTime } from './review-sql-time.js'

export interface SelectedManualCandidate {
  id: string; trading_account_id: string; revision: number; evidence_sha256: string
  ticket: string; position_id: string | null; symbol: string; side: string; volume: string; net_profit: string
  opened_at_utc: Date | string; closed_at_utc: Date | string; terminal_timezone_offset_minutes: number
}
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : null
const decimal = (value: unknown) => {
  if (typeof value !== 'string' || !/^-?\d{1,16}(?:\.\d{1,8})?$/.test(value)) return null
  const [whole, fraction = ''] = value.replace(/^-/, '').split('.')
  return BigInt(whole! + fraction.padEnd(8, '0')) * (value.startsWith('-') ? -1n : 1n)
}

/** Candidate row is already locked by createManualCase. Never substitute a summary for a missing payload. */
export async function readManualCandidateEvidence(connection: Pick<PoolConnection, 'execute'>,
  userId: number, candidate: SelectedManualCandidate): Promise<Record<string, unknown>> {
  const [rows] = await connection.execute<(RowDataPacket & { evidence_json: unknown; evidence_sha256: string;
    trade_record_id: string; trade_record_revision: number; as_of_utc: Date | string })[]>(`SELECT evidence_json,evidence_sha256,
    trade_record_id,trade_record_revision,as_of_utc FROM manual_review_candidate_evidence_v4
    WHERE candidate_id=? AND candidate_revision=? LIMIT 1 FOR SHARE`, [candidate.id,candidate.revision])
  const row = rows[0]
  if (!row || row.evidence_sha256 !== candidate.evidence_sha256) throw new ReviewError('manual_review_evidence_unavailable', 409)
  let payload: Record<string, unknown>
  try { payload = verifiedReviewEvidence(row.evidence_json, row.evidence_sha256) }
  catch { throw new ReviewError('manual_review_evidence_corrupt', 409) }
  const trade = object(payload.trade), evidence = object(trade?.evidence), projection = object(evidence?.projection)
  if (payload.schema_version !== 'manual-candidate-evidence.v4.1' || !object(payload.authority)
    || !trade || trade.status !== 'ready_as_of' || typeof trade.receiptId !== 'string' || !trade.receiptId
    || typeof trade.taskId !== 'string' || !trade.taskId || !/^[a-f0-9]{64}$/.test(String(trade.completionHash))
    || trade.asOfUtcMsc !== Date.parse(reviewIsoTime(row.as_of_utc))
    || !evidence || evidence.source !== 'manual' || evidence.userId !== userId
    || evidence.accountId !== String(candidate.trading_account_id) || evidence.recordId !== row.trade_record_id
    || evidence.revision !== Number(row.trade_record_revision) || !Array.isArray(evidence.facts) || !evidence.facts.length
    || evidence.openedAt !== reviewIsoTime(candidate.opened_at_utc) || evidence.closedAt !== reviewIsoTime(candidate.closed_at_utc)
    || evidence.terminalTimezoneOffsetMinutes !== Number(candidate.terminal_timezone_offset_minutes)
    || !projection || projection.primaryTicket !== candidate.ticket || projection.positionId !== candidate.position_id
    || projection.symbol !== candidate.symbol || projection.side !== candidate.side
    || decimal(projection.volumeOpened) === null || decimal(projection.volumeOpened) !== decimal(String(candidate.volume))
    || decimal(projection.netProfit) === null || decimal(projection.netProfit) !== decimal(String(candidate.net_profit))) {
    throw new ReviewError('manual_review_evidence_scope_mismatch', 409)
  }
  return payload
}
