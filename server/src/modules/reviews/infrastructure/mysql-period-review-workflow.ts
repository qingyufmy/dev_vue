import type { PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import type { PeriodReviewScope, PeriodReviewProgress, PeriodReviewTransition } from '../application/period-review-workflow.js'
import { reviewPeriodCalendar } from '../domain/review-period-calendar.js'
import { sha256Canonical } from '../../../shared/canonical-json.js'

const fields = `id,user_id,CAST(trading_account_id AS CHAR) account_id,ownership_interval_id,period_kind,period_key,
  phase,progress_json,progress_sha256,CAST(revision AS CHAR) revision,next_attempt_at_utc<=UTC_TIMESTAMP(3) due`
const uuid = (value: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
function scopeOf(row: RowDataPacket): PeriodReviewScope {
  return { userId:Number(row.user_id),accountId:String(row.account_id),ownershipIntervalId:String(row.ownership_interval_id),
    kind:row.period_kind,key:row.period_key }
}
function verified(row: RowDataPacket) {
  const progress: PeriodReviewProgress = typeof row.progress_json === 'string' ? JSON.parse(row.progress_json) : row.progress_json
  if (!progress || sha256Canonical(progress) !== row.progress_sha256 || progress.phase !== row.phase) throw Error('period_workflow_progress_corrupt')
  return structuredClone(progress)
}

/** Caller owns a short transaction. lockAccount must use this same connection and precedes all workflow locks. */
export function createMysqlPeriodReviewWorkflow(connection: Pick<PoolConnection,'execute'>, lockAccount: (accountId: string) => Promise<void>) {
  return {
    async register(id: string, input: PeriodReviewScope) {
      const scope = structuredClone(input)
      reviewPeriodCalendar(scope.kind,scope.key)
      if (!uuid(id) || !uuid(scope.ownershipIntervalId) || !Number.isSafeInteger(scope.userId) || scope.userId < 1
        || !/^[1-9]\d{0,19}$/.test(scope.accountId)) throw Error('period_workflow_scope_invalid')
      await lockAccount(scope.accountId)
      const progress: PeriodReviewProgress = { phase:'planning' }
      await connection.execute(`INSERT INTO period_review_workflows_v4
        (id,user_id,trading_account_id,ownership_interval_id,period_kind,period_key,phase,progress_json,progress_sha256,next_attempt_at_utc,created_at_utc,updated_at_utc)
        VALUES (?,?,?,?,?,?,'planning',?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),UTC_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE id=id`,
      [id,scope.userId,scope.accountId,scope.ownershipIntervalId,scope.kind,scope.key,JSON.stringify(progress),sha256Canonical(progress)])
      const [rows] = await connection.execute<RowDataPacket[]>(`SELECT ${fields} FROM period_review_workflows_v4
        WHERE user_id=? AND trading_account_id=? AND ownership_interval_id=? AND period_kind=? AND period_key=? FOR UPDATE`,
      [scope.userId,scope.accountId,scope.ownershipIntervalId,scope.kind,scope.key])
      if (rows.length !== 1) throw Error('period_workflow_registration_conflict')
      verified(rows[0]!); return { id:String(rows[0]!.id),phase:rows[0]!.phase as PeriodReviewProgress['phase'] }
    },
    async run(id: string, advance: (scope: PeriodReviewScope,progress: PeriodReviewProgress,nowUtcMsc:number) => Promise<PeriodReviewTransition>) {
      if (!uuid(id)) throw Error('period_workflow_id_invalid')
      const [identity] = await connection.execute<RowDataPacket[]>('SELECT CAST(trading_account_id AS CHAR) account_id FROM period_review_workflows_v4 WHERE id=?',[id])
      if (!identity.length) return { status:'missing' as const }
      await lockAccount(String(identity[0]!.account_id))
      const [[row]] = await connection.execute<RowDataPacket[]>(`SELECT ${fields},CAST(UNIX_TIMESTAMP(UTC_TIMESTAMP(3))*1000 AS CHAR) now_msc
        FROM period_review_workflows_v4 WHERE id=? FOR UPDATE`,[id])
      if (!row || row.account_id !== identity[0]!.account_id) throw Error('period_workflow_identity_changed')
      const progress = verified(row)
      if (progress.phase === 'succeeded' || !Number(row.due)) return { status:'unchanged' as const,phase:progress.phase }
      const result = await advance(scopeOf(row),progress,Number(row.now_msc))
      if ((result.progress.phase === 'succeeded') !== (result.retryAfterMs === null)
        || (progress.phase === 'history' && result.progress.phase === 'planning')
        || (result.retryAfterMs !== null && (!Number.isSafeInteger(result.retryAfterMs) || result.retryAfterMs < 0 || result.retryAfterMs > 3_600_000))
        || (result.reason !== null && !/^[a-z][a-z0-9_]{0,127}$/.test(result.reason))) throw Error('period_workflow_transition_invalid')
      const [updated] = await connection.execute<ResultSetHeader>(`UPDATE period_review_workflows_v4 SET phase=?,progress_json=?,progress_sha256=?,revision=revision+1,attempts=attempts+1,
        next_attempt_at_utc=IF(? IS NULL,NULL,TIMESTAMPADD(MICROSECOND,?,UTC_TIMESTAMP(3))),last_reason=?,updated_at_utc=UTC_TIMESTAMP(3)
        WHERE id=? AND revision=?`,[result.progress.phase,JSON.stringify(result.progress),sha256Canonical(result.progress),
      result.retryAfterMs,result.retryAfterMs === null ? null : result.retryAfterMs*1000,result.reason,id,row.revision])
      if (updated.affectedRows !== 1) throw Error('period_workflow_revision_conflict')
      return { status:'advanced' as const,phase:result.progress.phase }
    },
  }
}
