import type { Pool, RowDataPacket } from 'mysql2/promise'
export function createNotificationSourceReader(pool: Pool) {
  return async (kind: 'analysis' | 'decision', id: string) => {
    const sql = kind === 'analysis'
      ? "SELECT id,owner_user_id user_id,standard_symbol symbol,summary,opportunity <> 'none' actionable,created_at_utc FROM market_analyses WHERE id=?"
      : "SELECT d.id,d.user_id,a.standard_symbol symbol,d.summary,d.action_kind <> 'hold' actionable,d.created_at_utc FROM trade_decisions d JOIN market_analyses a ON a.id=d.market_analysis_id WHERE d.id=?"
    const [rows] = await pool.execute<RowDataPacket[]>(sql,[id])
    const r = rows[0]
    return r && Number(r.user_id)>0 ? {userId:Number(r.user_id),resourceId:r.id,kind,title:`${r.symbol} · ${kind === 'analysis' ? '行情分析' : '交易决策'}`,summary:String(r.summary),actionable:Number(r.actionable)===1,createdAt:r.created_at_utc} : null
  }
}
