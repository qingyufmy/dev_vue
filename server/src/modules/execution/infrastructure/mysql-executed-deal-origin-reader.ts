import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { TradeDecisionOriginReader } from '../../inference/index.js'
import type { ExecutedDealOrigin, ExecutedDealOriginReader } from '../application/executed-deal-origin-reader.js'
import { canonicalHash, type BridgeCommandRequestEnvelope } from '../domain/bridge-command.js'
import { closeReceiptTickets } from '../domain/partial-close-receipt.js'

interface Row extends RowDataPacket {
  command_id: string; intent_id: string; action: 'order.place' | 'position.close'
  decision_id: string; risk_id: string; result_json: unknown; result_sha256: string
  request_json: string | BridgeCommandRequestEnvelope; request_sha256: string; connection_epoch: number
  terminal_code: string | null; issued_msc: string; completed_msc: string
}
const ticket = (v: unknown): v is string => typeof v === 'string' && /^[1-9]\d{0,19}$/.test(v) && BigInt(v) <= 18446744073709551615n

/** Caller owns authorization and one consistent snapshot, including the injected decision reader. */
export function createMysqlExecutedDealOriginReader(connection: Pick<PoolConnection, 'execute'>,
  decisions: TradeDecisionOriginReader): ExecutedDealOriginReader {
  return { async read(input) {
    const scope = structuredClone(input)
    if (!Number.isSafeInteger(scope.userId) || scope.userId < 1 || !ticket(scope.accountId)
      || !Number.isSafeInteger(scope.connectionEpoch) || scope.connectionEpoch < 1
      || [scope.terminalInstanceId, scope.brokerServer, scope.login].some(v => typeof v !== 'string' || !v || v.length > 128)
      || !Array.isArray(scope.deals) || scope.deals.length > 1000
      || scope.deals.some(d => !ticket(d.ticket) || !ticket(d.orderTicket) || !ticket(d.positionId)
        || !Number.isSafeInteger(d.occurredAtUtcMsc) || d.occurredAtUtcMsc <= 0)
      || new Set(scope.deals.map(d => d.ticket)).size !== scope.deals.length) throw Error('executed_deal_origin_scope_invalid')
    if (!scope.deals.length) return []
    const orders = [...new Set(scope.deals.map(d => d.orderTicket))]
    const paths = ['$.order', '$.order_ticket', '$.raw_result.order', '$.raw_result.order_ticket']
    const filter = paths.map(path => `JSON_UNQUOTE(JSON_EXTRACT(r.result_json,'${path}')) IN (${orders.map(() => '?').join(',')})`).join(' OR ')
    const [rows] = await connection.execute<Row[]>(`SELECT c.id command_id,i.id intent_id,c.action,
      i.trade_decision_id decision_id,i.risk_decision_id risk_id,r.result_json,r.result_sha256,r.terminal_code,
      p.request_envelope_json request_json,c.request_sha256,c.connection_epoch,
      CAST(TIMESTAMPDIFF(MICROSECOND,'1970-01-01',c.issued_at_utc) DIV 1000 AS CHAR) issued_msc,
      CAST(TIMESTAMPDIFF(MICROSECOND,'1970-01-01',r.completed_at_utc) DIV 1000 AS CHAR) completed_msc
      FROM execution_intents i INNER JOIN bridge_commands_v4 c ON c.execution_intent_id=i.id
        AND c.user_id=i.user_id AND c.trading_account_id=i.trading_account_id
      INNER JOIN bridge_command_payloads_v4 p ON p.bridge_command_id=c.id
      INNER JOIN bridge_command_results_v4 r ON r.bridge_command_id=c.id AND r.message_id=c.result_message_id
        AND r.result_sha256=c.result_sha256 AND r.action=c.action AND r.completed_at_utc=c.completed_at_utc
      WHERE i.user_id=? AND i.trading_account_id=? AND i.source_type='risk_decision' AND i.source_id=i.risk_decision_id
        AND i.trade_decision_id IS NOT NULL AND i.status='succeeded' AND c.status='succeeded' AND r.status='succeeded'
        AND r.conflict=0 AND r.error_code IS NULL
        AND ((i.action_kind IN ('market_order','pending_order') AND c.action='order.place')
          OR (i.action_kind='close_position' AND c.action='position.close'))
        AND BINARY c.terminal_instance_id=BINARY ? AND BINARY c.broker_server=BINARY ? AND BINARY c.account_login=BINARY ?
        AND c.connection_epoch<=? AND (${filter}) ORDER BY c.id LIMIT 1001`,
    [scope.userId, scope.accountId, scope.terminalInstanceId, scope.brokerServer, scope.login, scope.connectionEpoch, ...paths.flatMap(() => orders)])
    if (rows.length > 1000) throw Error('executed_deal_origin_capacity_exceeded')
    const found = new Map<string, ExecutedDealOrigin>()
    for (const row of rows) {
      const issued = Number(row.issued_msc), completed = Number(row.completed_msc)
      if (!Number.isSafeInteger(issued) || !Number.isSafeInteger(completed) || issued <= 0 || completed < issued) throw Error('executed_deal_receipt_corrupt')
      let result: unknown
      try { result = typeof row.result_json === 'string' ? JSON.parse(row.result_json) : row.result_json }
      catch { throw Error('executed_deal_receipt_corrupt') }
      const payload = { command_id: row.command_id, action: row.action, status: 'succeeded', completed_at_utc_msc: completed, result, error_code: null }
      const variants: unknown[] = row.terminal_code === null ? [payload, { ...payload, terminal_code: null }] : [{ ...payload, terminal_code: row.terminal_code }]
      if (row.terminal_code !== null && Number.isFinite(Number(row.terminal_code)) && String(Number(row.terminal_code)) === row.terminal_code) variants.push({ ...payload, terminal_code: Number(row.terminal_code) })
      if (!variants.some(value => canonicalHash(value) === row.result_sha256)) throw Error('executed_deal_receipt_corrupt')
      let request: BridgeCommandRequestEnvelope
      try { request = typeof row.request_json === 'string' ? JSON.parse(row.request_json) : row.request_json }
      catch { throw Error('executed_deal_request_corrupt') }
      if (!request || request.v !== 4 || request.type !== 'command.request' || request.correlation_id !== row.intent_id
        || request.payload?.command_id !== row.command_id || request.payload.action !== row.action
        || request.payload.issued_at_utc_msc !== issued || canonicalHash(request.payload) !== row.request_sha256
        || request.route?.terminal_instance_id !== scope.terminalInstanceId
        || request.route.account_ref?.broker_server !== scope.brokerServer || request.route.account_ref?.login !== scope.login
        || !Number.isSafeInteger(request.route.connection_epoch) || request.route.connection_epoch < 1
        || request.route.connection_epoch > scope.connectionEpoch || request.route.connection_epoch !== Number(row.connection_epoch)) throw Error('executed_deal_request_corrupt')
      const matching = scope.deals.filter(deal => {
        if (row.action === 'position.close' && request.payload.params?.ticket !== deal.positionId) return false
        // The same receipt may cover several fills, but never substitute a position ID for a deal.
        let exact
        try { exact = closeReceiptTickets(result, deal.positionId) } catch { return false }
        return exact?.orderTicket === deal.orderTicket && exact.dealTickets.includes(deal.ticket)
          && deal.occurredAtUtcMsc >= issued && deal.occurredAtUtcMsc <= completed
      })
      if (!matching.length) continue
      const origin = await decisions.read({ decisionId: row.decision_id, riskDecisionId: row.risk_id, userId: scope.userId, accountId: scope.accountId })
      if (!origin || origin.decisionId !== row.decision_id || origin.userId !== scope.userId || origin.accountId !== scope.accountId
        || !ticket(origin.strategyId) || !ticket(origin.strategyVersionId)) throw Error('executed_deal_decision_unavailable')
      for (const deal of matching) {
        if (found.has(deal.ticket)) throw Error('executed_deal_origin_ambiguous')
        found.set(deal.ticket, { dealTicket: deal.ticket, orderTicket: deal.orderTicket, commandId: row.command_id,
          intentId: row.intent_id, action: row.action, resultHash: row.result_sha256, decisionId: row.decision_id,
          riskDecisionId: row.risk_id, strategyId: origin.strategyId, strategyVersionId: origin.strategyVersionId })
      }
    }
    return [...found.values()]
  } }
}
