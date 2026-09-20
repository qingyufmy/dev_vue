import { createTradeHistoryHttp } from '../src/modules/trade-history/composition.js'
import Fastify from 'fastify'
import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { classifyTradeAttribution, TradeHistoryService, type TradeHistoryRepository, type TradeRecordDetail } from '../src/modules/trade-history/index.js'
import { AuthError } from '../src/modules/auth/index.js'

const now = '2026-09-04T08:00:00.000Z'
const item = { accountCurrency: 'USD', currencyEvidence: 'explicit_record' as const,
  id: 'trade-1', accountId: '42', platform: 'mt5' as const, primaryTicket: '1001', positionId: '9001', symbol: 'XAUUSD', side: 'buy' as const,
  status: 'closed' as const, source: 'system' as const, attributionStatus: 'exact' as const, evidenceStatus: 'complete' as const,
  volume: '0.10', entryPrice: '2500.10', exitPrice: '2510.10', stopLoss: '2490', takeProfit: '2520', grossProfit: '100', commission: '-2',
  swap: '-1', fee: '0', netProfit: '97', openedAt: '2026-09-04T07:00:00.000Z', closedAt: '2026-09-04T07:30:00.000Z',
  terminalTimezoneOffsetMinutes: 180, revision: 1,
}
const summary = { accountCurrency: 'USD', moneyStatus: 'comparable' as const, tradeCount: 1, winningCount: 1, losingCount: 0, breakevenCount: 0, winRatePercent: '100', grossProfit: '100', commission: '-2', swap: '-1', fee: '0', netProfit: '97', profitFactor: null }
const detail: TradeRecordDetail = { ...item, evidenceHash: 'a'.repeat(64), deals: [], attributions: [{ kind: 'market_analysis', sourceId: 'analysis-1', relation: 'opened', proofKind: 'terminal_deal' }] }

function repository(overrides: Partial<TradeHistoryRepository> = {}): TradeHistoryRepository {
  return {
    canReadHistoryAccount: async () => true,
    list: async () => ({ items: [item], hasMore: false, freshness: { status: 'ready', blockingReason: null, historyRevision: 8, freshThrough: now, lastSuccessAt: now }, summary, daily: [{ businessDate: '2026-09-04', tradeCount: 1, netProfit: '97', cumulativeNetProfit: '97' }] }),
    find: async () => detail,
    ...overrides,
  }
}

describe('Stage 12S authoritative trade history', () => {
  it('preserves authentication errors before validating malformed input', async () => {
    const app = Fastify(), list = vi.fn()
    await app.register(createTradeHistoryHttp(new TradeHistoryService(repository({ list })), {
      async authenticate() { throw new AuthError('auth_required', 401) },
    }))
    try {
      const result = await app.inject('/api/v4/trade-history?page_size=wrong')
      expect(result.statusCode).toBe(401)
      expect(result.headers['content-type']).toContain('application/problem+json')
      expect(result.json().code).toBe('auth_required')
      expect(list).not.toHaveBeenCalled()
    } finally { await app.close() }
  })

  it('rejects malformed query values before the service accesses data', async () => {
    const app = Fastify(), list = vi.fn()
    await app.register(createTradeHistoryHttp(new TradeHistoryService(repository({ list })), { async authenticate() { return { userId: 7 } } }))
    try {
      for (const query of ['account_id=42&page_size=1e2', 'account_id=42&side=unknown', 'account_id=42&from_date=invalid']) {
        const result = await app.inject('/api/v4/trade-history?' + query)
        expect(result.statusCode).toBe(400)
        expect(result.json().code).toBe('api_request_invalid')
      }
      expect(list).not.toHaveBeenCalled()
    } finally { await app.close() }
  })

  it('blocks invalid successful output without echoing its contents', async () => {
    const app = Fastify(), bad = { ...detail, closedAt: 'internal-invalid-time' }
    await app.register(createTradeHistoryHttp(new TradeHistoryService(repository({ find: async () => bad })), { async authenticate() { return { userId: 7 } } }))
    try {
      const result = await app.inject('/api/v4/trade-history/trade-1')
      expect(result.statusCode).toBe(503)
      expect(result.json().code).toBe('api_response_invalid')
      expect(result.body).not.toContain('internal-invalid-time')
    } finally { await app.close() }
  })
  it('freezes pagination and rejects a cursor reused with different filters', async () => {
    const list = vi.fn(repository().list)
    const service = new TradeHistoryService(repository({ list: async (...args) => list(...args) }), () => new Date(now))
    const first = await service.records(7, { accountId: '42', symbol: 'XAUUSD', pageSize: 1 })
    expect(first.capturedEnd).toBe(now)
    expect(first.nextCursor).toBeNull()

    const moreRepository = repository({ list: async () => ({ ...(await repository().list(7, {} as never)), hasMore: true }) })
    const moreService = new TradeHistoryService(moreRepository, () => new Date(now))
    const page = await moreService.records(7, { accountId: '42', symbol: 'XAUUSD', pageSize: 1 })
    expect(page.nextCursor).toBeTruthy()
    await expect(moreService.records(7, { accountId: '42', symbol: 'EURUSD', cursor: page.nextCursor! })).rejects.toMatchObject({ code: 'trade_history_cursor_invalid' })
  })

  it('checks personal history access rather than current ownership before querying history', async () => {
    const list = vi.fn()
    const service = new TradeHistoryService(repository({ canReadHistoryAccount: async () => false, list }))
    await expect(service.records(7, { accountId: '42' })).rejects.toMatchObject({ code: 'trade_history_account_forbidden', status: 403 })
    expect(list).not.toHaveBeenCalled()
  })

  it('classifies sources only from exact proofs and preserves mixed lifecycle ownership', () => {
    expect(classifyTradeAttribution([{ source: 'manual', relation: 'opened', exact: false }])).toEqual({ source: 'unknown', status: 'unresolved', provenSources: [] })
    expect(classifyTradeAttribution([{ source: 'system', relation: 'opened', exact: true }])).toEqual({ source: 'system', status: 'exact', provenSources: ['system'] })
    expect(classifyTradeAttribution([
      { source: 'system', relation: 'opened', exact: true },
      { source: 'manual', relation: 'closed', exact: true },
    ])).toEqual({ source: 'mixed', status: 'exact', provenSources: ['system', 'manual'] })
  })

  it('uses inclusive terminal business dates rather than browser UTC-day conversion', async () => {
    const list = vi.fn(repository().list)
    const service = new TradeHistoryService(repository({ list: async (...args) => list(...args) }), () => new Date(now))
    await service.records(7, { accountId: '42', fromDate: '2026-09-04', toDate: '2026-09-04' })
    expect(list.mock.calls[0]?.[1]).toMatchObject({ fromBusinessDate: '2026-09-04', toBusinessDate: '2026-09-04' })
    await expect(service.records(7, { accountId: '42', fromDate: '2026-09-31' })).rejects.toMatchObject({ code: 'trade_history_from_date_invalid' })
  })

  it('returns normalized DTOs and exact evidence links without exposing raw terminal payloads', async () => {
    const app = Fastify({ logger: false })
    await app.register(createTradeHistoryHttp(new TradeHistoryService(repository(), () => new Date(now)), { async authenticate() { return { userId: 7 } } }))
    const list = await app.inject({ method: 'GET', url: '/api/v4/trade-history?account_id=42' })
    expect(list.statusCode).toBe(200)
    expect(list.json().data).toMatchObject({ captured_end: now, freshness: { history_revision: '8' }, summary: { account_currency: 'USD', money_status: 'comparable' }, items: [{ account_currency: 'USD', currency_evidence: 'explicit_record', primary_ticket: '1001', source: 'system', net_profit: '97' }] })
    const record = await app.inject({ method: 'GET', url: '/api/v4/trade-history/trade-1' })
    expect(record.statusCode).toBe(200)
    expect(record.json().data.attributions).toEqual([{ kind: 'market_analysis', source_id: 'analysis-1', relation: 'opened', proof_kind: 'terminal_deal' }])
    expect(record.body).not.toContain('evidence_json')
    await app.close()
  })

  it('preserves unavailable money as null through HTTP', async () => {
    const base = await repository().list(7, { accountId: '42', capturedEnd: now, limit: 50, cursor: null })
    const repo = repository({ list: async () => ({ ...base,
      summary: { ...summary, accountCurrency: null, moneyStatus: 'unknown', grossProfit: null, commission: null, swap: null, fee: null, netProfit: null, profitFactor: null },
      daily: [{ businessDate: '2026-09-04', tradeCount: 1, netProfit: null, cumulativeNetProfit: null }],
    }) })
    const app = Fastify({ logger: false })
    await app.register(createTradeHistoryHttp(new TradeHistoryService(repo, () => new Date(now)), { async authenticate() { return { userId: 7 } } }))
    try {
      const result = await app.inject({ method: 'GET', url: '/api/v4/trade-history?account_id=42' })
      expect(result.statusCode).toBe(200)
      expect(result.json().data).toMatchObject({ summary: { account_currency: null, money_status: 'unknown', net_profit: null, profit_factor: null }, daily: [{ net_profit: null, cumulative_net_profit: null }] })
    } finally { await app.close() }
  })

  it('keeps the migration append-only and separates terminal facts from account-level records', async () => {
    const sql = await readFile(new URL('../db/migrations/20260904_013_authoritative_trade_history.sql', import.meta.url), 'utf8')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS terminal_history_orders_v4')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS terminal_history_deals_v4')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS account_trade_records_v4')
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS account_trade_attributions_v4')
    expect(sql).toContain("source_classification ENUM('system','manual','other_ea','mixed','unknown')")
    expect(sql).toContain('trade_history_migration_checkpoints_v4')
    expect(sql).not.toMatch(/\b(?:DROP|DELETE|TRUNCATE)\b/i)
  })

  it('publishes the HTTP and invalidation-only realtime contracts', async () => {
    const openapi = JSON.parse(await readFile(new URL('../../contracts/openapi-v4.json', import.meta.url), 'utf8'))
    const realtime = JSON.parse(await readFile(new URL('../../contracts/realtime-v4.schema.json', import.meta.url), 'utf8'))
    expect(openapi.paths['/trade-history'].get.operationId).toBe('listTradeHistory')
    expect(openapi.paths['/trade-history/{trade_record_id}'].get.operationId).toBe('getTradeRecord')
    expect(openapi.components.schemas.TradeHistoryPageResponse).toBeTruthy()
    expect(realtime.$defs.ServerEventType.enum).toContain('trade.history.changed')
    expect(realtime.$defs.SubscriptionTarget.properties.kind.enum).toContain('trades')
    expect(realtime.$defs.TradeHistoryChangedData.required).toEqual(['status', 'history_revision', 'fresh_through'])
  })
})
