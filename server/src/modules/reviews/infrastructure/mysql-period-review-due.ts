import type { Pool, RowDataPacket } from 'mysql2/promise'

export function createMysqlPeriodReviewDue(pool: Pick<Pool,'execute'>) {
  return { async list(after: string|null,limit:number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (after !== null && !/^[a-f0-9-]{36}$/i.test(after))) throw Error('period_review_due_invalid')
    const [rows] = await pool.execute<RowDataPacket[]>(`SELECT id FROM period_review_workflows_v4
      WHERE phase IN ('planning','history') AND next_attempt_at_utc<=UTC_TIMESTAMP(3) AND (? IS NULL OR id>?)
      ORDER BY id LIMIT ?`,[after,after,limit])
    return rows.map(row=>String(row.id))
  } }
}
