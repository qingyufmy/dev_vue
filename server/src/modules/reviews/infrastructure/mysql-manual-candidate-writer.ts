import { createHash, randomUUID } from 'node:crypto'
import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { ManualCandidateWriter } from '../application/manual-candidate-collector.js'
import { ReviewError } from '../domain/review.js'
import { reviewEvidenceHash, verifiedReviewEvidence } from './review-evidence-integrity.js'
import { reviewSqlTime, reviewIsoTime } from './review-sql-time.js'

interface CandidateRow extends RowDataPacket {
  id: string; revision: number; evidence_sha256: string; eligibility_status: string; selection_expires_at_utc: Date | string
}
interface EvidenceRow extends RowDataPacket {
  trade_record_id: string; trade_record_revision: number; as_of_utc: Date | string
  evidence_json: string | object; evidence_sha256: string
}

/** Caller owns a transaction spanning authority, trade readiness and this writer. */
export function createMysqlManualCandidateWriter(connection: PoolConnection): ManualCandidateWriter {
  return { async write({ trade, authority }) {
    const e = trade.evidence, p = e.projection
    if (e.source !== 'manual' || !p.stableKey || !Number.isSafeInteger(e.revision) || e.revision < 1) {
      throw new ReviewError('manual_review_source_invalid', 409)
    }
    const payload = { schema_version: 'manual-candidate-evidence.v4.1', trade, authority }
    const hash = reviewEvidenceHash(payload), json = JSON.stringify(payload)
    if (Buffer.byteLength(json) > 4 * 1024 * 1024) throw new ReviewError('manual_review_evidence_too_large', 422)
    const [[clock]] = await connection.execute<(RowDataPacket & { now: string })[]>(
      "SELECT DATE_FORMAT(UTC_TIMESTAMP(3),'%Y-%m-%dT%H:%i:%s.%fZ') now")
    const now = reviewIsoTime(clock!.now.replace(/(\.\d{3})000Z$/, '$1Z'))
    const asOf = reviewSqlTime(new Date(trade.asOfUtcMsc).toISOString())
    if (trade.asOfUtcMsc > Date.parse(now)) throw new ReviewError('manual_review_cutoff_invalid', 409)
    const expires = reviewSqlTime(new Date(Date.parse(now) + 15 * 60_000).toISOString())
    const candidateId = randomUUID()
    const token = (id: string, revision: number) => createHash('sha256').update(`${id}.${revision}.${hash}`).digest('hex')
    await connection.execute(`INSERT INTO manual_review_candidates_v4
      (id,user_id,trading_account_id,stable_trade_key,ticket,position_id,symbol,side,volume,opened_at_utc,closed_at_utc,
        net_profit,terminal_timezone_offset_minutes,source_classification,eligibility_status,evidence_sha256,
        selection_token_sha256,selection_expires_at_utc,observed_at_utc,revision)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'manual','eligible',?,?,?,?,1) ON DUPLICATE KEY UPDATE id=id`,
    [candidateId,e.userId,e.accountId,p.stableKey,p.primaryTicket,p.positionId,p.symbol,p.side,p.volumeOpened,
      reviewSqlTime(e.openedAt),reviewSqlTime(e.closedAt),p.netProfit,e.terminalTimezoneOffsetMinutes,
      hash,token(candidateId,1),expires,reviewSqlTime(now)])
    const [rows] = await connection.execute<CandidateRow[]>(`SELECT id,revision,evidence_sha256,eligibility_status,selection_expires_at_utc
      FROM manual_review_candidates_v4 WHERE user_id=? AND trading_account_id=? AND stable_trade_key=? FOR UPDATE`,
    [e.userId,e.accountId,p.stableKey])
    const row = rows[0]
    if (!row) throw new ReviewError('manual_review_candidate_write_failed', 409)
    const created = row.id === candidateId
    let revision = Number(row.revision)
    if (!created) {
      if (row.eligibility_status === 'already_reviewed') return { status: 'already_reviewed', candidateId: row.id, revision }
      const [previous] = await connection.execute<EvidenceRow[]>(`SELECT trade_record_id,trade_record_revision,as_of_utc,evidence_json,evidence_sha256
        FROM manual_review_candidate_evidence_v4 WHERE candidate_id=? AND candidate_revision=? FOR SHARE`, [row.id,revision])
      const old = previous[0]
      if (!old || old.evidence_sha256 !== row.evidence_sha256) throw new ReviewError('manual_review_evidence_unavailable', 409)
      verifiedReviewEvidence(old.evidence_json, old.evidence_sha256)
      if (old.trade_record_id !== e.recordId || Number(old.trade_record_revision) > e.revision
        || Date.parse(reviewIsoTime(old.as_of_utc)) > trade.asOfUtcMsc) throw new ReviewError('manual_review_evidence_stale', 409)
      if (row.evidence_sha256 === hash && row.eligibility_status === 'eligible'
        && Date.parse(reviewIsoTime(row.selection_expires_at_utc)) > Date.parse(now)) return { status: 'unchanged', candidateId: row.id, revision }
      revision++
      if (!Number.isSafeInteger(revision)) throw new ReviewError('manual_review_revision_invalid', 409)
      await connection.execute(`UPDATE manual_review_candidates_v4 SET ticket=?,position_id=?,symbol=?,side=?,volume=?,
        opened_at_utc=?,closed_at_utc=?,net_profit=?,terminal_timezone_offset_minutes=?,evidence_sha256=?,
        selection_token_sha256=?,selection_expires_at_utc=?,observed_at_utc=?,eligibility_status='eligible',revision=? WHERE id=?`,
      [p.primaryTicket,p.positionId,p.symbol,p.side,p.volumeOpened,reviewSqlTime(e.openedAt),reviewSqlTime(e.closedAt),p.netProfit,
        e.terminalTimezoneOffsetMinutes,hash,token(row.id,revision),expires,reviewSqlTime(now),revision,row.id])
    }
    await connection.execute(`INSERT INTO manual_review_candidate_evidence_v4
      (candidate_id,candidate_revision,trade_record_id,trade_record_revision,as_of_utc,evidence_json,evidence_sha256,payload_bytes,created_at_utc)
      VALUES (?,?,?,?,?,?,?,?,?)`, [row.id,revision,e.recordId,e.revision,asOf,json,hash,Buffer.byteLength(json),reviewSqlTime(now)])
    return { status: created ? 'created' : 'updated', candidateId: row.id, revision }
  } }
}
