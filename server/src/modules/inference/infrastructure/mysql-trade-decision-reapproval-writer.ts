import { randomUUID } from 'node:crypto'
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { TradeDecisionReapprovalWriter } from '../application/trade-decision-reapproval-writer.js'
import { InferenceError } from '../domain/inference.js'

export function createTradeDecisionReapprovalWriter(db: Pick<PoolConnection, 'execute'>): TradeDecisionReapprovalWriter {
  return { async request(input) {
    const [updated] = await db.execute<ResultSetHeader>(`UPDATE trade_decisions d
      INNER JOIN market_analyses a ON a.id=d.market_analysis_id
      SET d.status='proposed',d.risk_decision_id=NULL,d.revision=d.revision+1
      WHERE d.id=? AND d.user_id=? AND d.trading_account_id=? AND d.status='accepted'
        AND d.risk_decision_id=? AND a.valid_until_utc>UTC_TIMESTAMP(3)`,
    [input.decisionId,input.userId,input.accountId,input.riskDecisionId])
    if (updated.affectedRows !== 1) return false
    const [claims] = await db.execute<RowDataPacket[]>(`SELECT state,risk_decision_id FROM inference_entry_event_claims_v4
      WHERE decision_id=? AND user_id=? AND trading_account_id=? FOR UPDATE`,
    [input.decisionId,input.userId,input.accountId])
    if (claims.some(row => row.state !== 'consumed' || row.risk_decision_id !== input.riskDecisionId)) {
      throw new InferenceError('entry_event_reapproval_conflict',409)
    }
    // Keep active_event_id reserved for this decision throughout reapproval.
    const [reserved] = await db.execute<ResultSetHeader>(`UPDATE inference_entry_event_claims_v4
      SET state='reserved',risk_decision_id=NULL,updated_at_utc=UTC_TIMESTAMP(3)
      WHERE decision_id=? AND user_id=? AND trading_account_id=? AND state='consumed' AND risk_decision_id=?`,
    [input.decisionId,input.userId,input.accountId,input.riskDecisionId])
    if (reserved.affectedRows !== claims.length) throw new InferenceError('entry_event_reapproval_conflict',409)
    await db.execute(`INSERT INTO outbox_events
      (event_id,aggregate_type,aggregate_id,event_type,payload_json,status,attempts,available_at_utc,created_at_utc)
      VALUES (?,'trade_decision',?,'trade_decision.created',?,'pending',0,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`,
    [randomUUID(),input.decisionId,JSON.stringify({decision_id:input.decisionId,status:'proposed',
      previous_risk_decision_id:input.riskDecisionId,reason:'execution_dynamic_state_changed'})])
    return true
  } }
}
