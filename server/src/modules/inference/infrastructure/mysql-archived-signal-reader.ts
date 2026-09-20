import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { ArchivedSignalReader, ArchivedSignalSummary, ArchivedSignalDetail } from '../application/archived-signal-reader.js'
const summaryColumns = 'CAST(id AS CHAR) legacy_id,symbol,timeframe,signal_type,created_at created_at_utc'
function scope(userId: number) { if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('archive_user_invalid') }
function identity(id: string) { if (!/^[1-9][0-9]{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) throw new Error('archive_id_invalid') }
function utc(value: string | Date): string {
  if (value instanceof Date) return value.toISOString()
  return new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z').toISOString()
}
function summary(row: ArchivedSignalSummary & RowDataPacket): ArchivedSignalSummary {
  return { legacy_id: String(row.legacy_id), symbol: String(row.symbol), timeframe: String(row.timeframe), signal_type: String(row.signal_type), created_at_utc: utc(row.created_at_utc) }
}
export class MysqlArchivedSignalReader implements ArchivedSignalReader {
  constructor(private readonly pool: Pool) {}
  async list(userId: number, input: { limit: number; beforeId?: string }) {
    scope(userId)
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new Error('archive_limit_invalid')
    if (input.beforeId !== undefined) identity(input.beforeId)
    const [rows] = await this.pool.execute<(RowDataPacket & ArchivedSignalSummary)[]>(`SELECT ${summaryColumns} FROM ai_signals WHERE user_id=?${input.beforeId ? ' AND id<?' : ''} ORDER BY id DESC LIMIT ?`,
      [userId, ...(input.beforeId ? [input.beforeId] : []), String(input.limit + 1)])
    const items = rows.slice(0,input.limit).map(summary)
    return { items, nextCursor: rows.length > input.limit ? items.at(-1)!.legacy_id : null }
  }
  async get(userId: number, id: string) {
    scope(userId); identity(id)
    const [rows] = await this.pool.execute<(RowDataPacket & ArchivedSignalDetail)[]>(`SELECT ${summaryColumns},analysis,reasoning,inference_task_id FROM ai_signals WHERE id=? AND user_id=? LIMIT 1`, [id,userId])
    const row=rows[0]
    return row ? { ...summary(row), analysis: row.analysis == null ? null : String(row.analysis), reasoning: row.reasoning == null ? null : String(row.reasoning), inference_task_id: row.inference_task_id == null ? null : String(row.inference_task_id) } : null
  }
}
