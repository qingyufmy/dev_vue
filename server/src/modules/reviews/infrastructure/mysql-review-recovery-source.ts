import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { ReviewRecoverySource, ReviewRecoveryCandidate } from '../application/review-recovery.js'
export class MysqlReviewRecoverySource implements ReviewRecoverySource {
  constructor(private readonly pool: Pick<Pool, 'execute'>) {}
  async listDue(afterId: string | null, limit: number): Promise<ReviewRecoveryCandidate[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('review_recovery_limit_invalid')
    const [rows] = await this.pool.execute<(RowDataPacket & ReviewRecoveryCandidate)[]>(`SELECT j.id jobId,CAST(j.fencing_token AS CHAR) fencingToken
      FROM review_jobs_v4 j JOIN review_cases_v4 c ON c.id=j.review_case_id
      WHERE c.status IN ('queued','running','failed') AND c.legacy_source_table IS NULL
        AND ((j.status IN ('queued','retry_wait') AND (j.next_attempt_at_utc IS NULL OR j.next_attempt_at_utc<=UTC_TIMESTAMP(3)))
          OR (j.status IN ('preparing_evidence','waiting_model','validating') AND (j.lease_expires_at_utc IS NULL OR j.lease_expires_at_utc<=UTC_TIMESTAMP(3))))
        ${afterId === null ? '' : 'AND j.id>?'} ORDER BY j.id LIMIT ?`, [...(afterId === null ? [] : [afterId]), String(limit)])
    return rows.map(row => ({ jobId: row.jobId, fencingToken: row.fencingToken }))
  }
}
