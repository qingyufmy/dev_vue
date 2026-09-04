import type { FastifyPluginAsync } from 'fastify'
import type { TradeHistoryService } from '../../application/trade-history-service.js'
import { TradeHistoryError, type TradeRecordAttribution, type TradeRecordDeal, type TradeRecordDetail, type TradeRecordSummary } from '../../domain/trade-history.js'

export interface TradeHistoryRequestAuthenticator { authenticate(request: { headers: Record<string, unknown> }): Promise<{ userId: number }> }
export interface TradeHistoryRoutesOptions { service: TradeHistoryService; auth: TradeHistoryRequestAuthenticator }
const response = (requestId: string, data: unknown) => ({ data, meta: { request_id: requestId, generated_at: new Date().toISOString() } })

export const tradeHistoryRoutes: FastifyPluginAsync<TradeHistoryRoutesOptions> = async (fastify, options) => {
  fastify.get<{ Querystring: { account_id?: string; symbol?: string; side?: string; source?: string; outcome?: string; from_date?: string; to_date?: string; q?: string; page_size?: string; cursor?: string } }>('/trade-history', async (request, reply) => {
    try {
      const { userId } = await options.auth.authenticate(request)
      const result = await options.service.records(userId, {
        accountId: String(request.query.account_id ?? ''),
        ...(request.query.symbol ? { symbol: request.query.symbol } : {}), ...(request.query.side ? { side: request.query.side } : {}),
        ...(request.query.source ? { source: request.query.source } : {}), ...(request.query.outcome ? { outcome: request.query.outcome } : {}),
        ...(request.query.from_date ? { fromDate: request.query.from_date } : {}), ...(request.query.to_date ? { toDate: request.query.to_date } : {}),
        ...(request.query.q ? { query: request.query.q } : {}), ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
        pageSize: Number(request.query.page_size ?? 50),
      })
      return response(request.id, { captured_end: result.capturedEnd, freshness: { status: result.freshness.status, history_revision: String(result.freshness.historyRevision), fresh_through: result.freshness.freshThrough, last_success_at: result.freshness.lastSuccessAt }, items: result.items.map(recordDto), next_cursor: result.nextCursor, has_more: result.hasMore, summary: summaryDto(result.summary), daily: result.daily.map(item => ({ business_date: item.businessDate, trade_count: item.tradeCount, net_profit: item.netProfit, cumulative_net_profit: item.cumulativeNetProfit })) })
    } catch (error) { return problem(error, request, reply) }
  })

  fastify.get<{ Params: { recordId: string } }>('/trade-history/:recordId', async (request, reply) => {
    try { const { userId } = await options.auth.authenticate(request); return response(request.id, detailDto(await options.service.detail(userId, request.params.recordId))) }
    catch (error) { return problem(error, request, reply) }
  })
}

function recordDto(value: TradeRecordSummary) { return { id: value.id, account_id: value.accountId, platform: value.platform, primary_ticket: value.primaryTicket, position_id: value.positionId, symbol: value.symbol, side: value.side, status: value.status, source: value.source, attribution_status: value.attributionStatus, evidence_status: value.evidenceStatus, volume: value.volume, entry_price: value.entryPrice, exit_price: value.exitPrice, stop_loss: value.stopLoss, take_profit: value.takeProfit, gross_profit: value.grossProfit, commission: value.commission, swap: value.swap, fee: value.fee, net_profit: value.netProfit, opened_at: value.openedAt, closed_at: value.closedAt, terminal_timezone_offset_minutes: value.terminalTimezoneOffsetMinutes, revision: String(value.revision) } }
function detailDto(value: TradeRecordDetail) { return { ...recordDto(value), evidence_hash: value.evidenceHash, deals: value.deals.map(dealDto), attributions: value.attributions.map(attributionDto) } }
function dealDto(value: TradeRecordDeal) { return { id: value.id, deal_ticket: value.dealTicket, order_ticket: value.orderTicket, role: value.role, side: value.side, entry_kind: value.entryKind, volume: value.volume, price: value.price, gross_profit: value.grossProfit, commission: value.commission, swap: value.swap, fee: value.fee, occurred_at: value.occurredAt } }
function attributionDto(value: TradeRecordAttribution) { return { kind: value.kind, source_id: value.sourceId, relation: value.relation, proof_kind: value.proofKind } }
function summaryDto(value: Awaited<ReturnType<TradeHistoryService['records']>>['summary']) { return { trade_count: value.tradeCount, winning_count: value.winningCount, losing_count: value.losingCount, breakeven_count: value.breakevenCount, win_rate_percent: value.winRatePercent, gross_profit: value.grossProfit, commission: value.commission, swap: value.swap, fee: value.fee, net_profit: value.netProfit, profit_factor: value.profitFactor } }
function problem(error: unknown, request: { id: string; url: string }, reply: { code(status: number): { send(body: unknown): unknown } }) { const known = error instanceof TradeHistoryError ? error : new TradeHistoryError('trade_history_unavailable', 503); return reply.code(known.status).send({ type: `urn:aurum:problem:${known.code}`, title: 'Trade history request failed', status: known.status, code: known.code, detail: known.code, instance: request.url, correlation_id: request.id, retryable: known.status >= 500 }) }
