import type { Pool, RowDataPacket } from 'mysql2/promise'
import type { ArchivedExecutionReader, ArchivedExecutionSummary, ArchivedExecutionDetail } from '../application/archived-execution-reader.js'
const summaryColumns = 'CAST(id AS CHAR) legacy_id,CAST(trading_account_id AS CHAR) legacy_account_id,symbol,action,status,created_at created_at_utc'
function scope(userId: number) { if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('archive_user_invalid') }
function identity(id: string) { if (!/^[1-9][0-9]{0,18}$/.test(id) || BigInt(id) > 9223372036854775807n) throw new Error('archive_id_invalid') }
function utc(value: string | Date): string {
  if (value instanceof Date) return value.toISOString()
  return new Date(value.includes('T') ? value : value.replace(' ', 'T') + 'Z').toISOString()
}
function summary(row: ArchivedExecutionSummary & RowDataPacket): ArchivedExecutionSummary {
  return { legacy_id: String(row.legacy_id), legacy_account_id: row.legacy_account_id == null ? null : String(row.legacy_account_id), symbol: row.symbol == null ? null : String(row.symbol), action: String(row.action), status: String(row.status), created_at_utc: utc(row.created_at_utc) }
}
export class MysqlArchivedExecutionReader implements ArchivedExecutionReader {
  constructor(private readonly pool: Pool) {}
  async list(userId: number, input: { limit: number; beforeId?: string }) {
    scope(userId)
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new Error('archive_limit_invalid')
    if (input.beforeId !== undefined) identity(input.beforeId)
    const [rows] = await this.pool.execute<(RowDataPacket & ArchivedExecutionSummary)[]>(`SELECT ${summaryColumns} FROM order_intents WHERE user_id=?${input.beforeId ? ' AND id<?' : ''} ORDER BY id DESC LIMIT ?`,
      [userId, ...(input.beforeId ? [input.beforeId] : []), String(input.limit + 1)])
    const items = rows.slice(0,input.limit).map(summary)
    return { items, nextCursor: rows.length > input.limit ? items.at(-1)!.legacy_id : null }
  }
  async get(userId: number, id: string) {
    scope(userId); identity(id)
    const [rows] = await this.pool.execute<(RowDataPacket & ArchivedExecutionDetail)[]>(`SELECT ${summaryColumns},trade_ticket,pending_ticket,error_code,completed_at completed_at_utc FROM order_intents WHERE id=? AND user_id=? LIMIT 1`, [id,userId])
    const row=rows[0]
    return row ? { ...summary(row), trade_ticket: row.trade_ticket == null ? null : String(row.trade_ticket), pending_ticket: row.pending_ticket == null ? null : String(row.pending_ticket), error_code: row.error_code == null ? null : String(row.error_code), completed_at_utc: row.completed_at_utc == null ? null : utc(row.completed_at_utc) } : null
  }
}
