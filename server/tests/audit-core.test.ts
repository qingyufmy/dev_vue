import Fastify from 'fastify'
import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import type { AuditEventDetail } from '../src/modules/audit/index.js'
import { AuditService } from '../src/modules/audit/application/audit-service.js'
import type { AuditRepository } from '../src/modules/audit/application/audit-ports.js'
import { auditRoutes } from '../src/modules/audit/transport/http/audit-routes.js'
import { AuthError } from '../src/modules/auth/index.js'
import { BrowserRealtimeHub, BrowserRealtimeSession } from '../src/modules/trading/index.js'

const now = '2026-09-04T08:00:00.000Z'
const event = {
  sourceKind: 'operation' as const, sourceId: 'operation-1', accountId: '42', category: 'execution' as const,
  actor: 'system' as const, action: 'position.close', status: 'succeeded' as const, title: '交易操作', summary: 'ticket-1',
  reasonCode: null, symbol: 'XAUUSD', occurredAt: now, terminalTimezoneOffsetMinutes: 180, correlationId: 'operation-1',
}
const detail: AuditEventDetail = { event, trace: [{ stage: 'analysis', status: 'succeeded', sourceKind: 'market_analysis',
  sourceId: 'analysis-1', title: 'AI 分析师', detail: '偏多候选', reasonCode: null, occurredAt: now },
{ stage: 'bridge', status: 'succeeded', sourceKind: 'bridge_command', sourceId: 'command-1', title: 'Bridge 指令',
  detail: 'position.close', reasonCode: null, occurredAt: now }], evidence: [{ label: '交易账户', value: '42' }],
links: [{ kind: 'operation', id: 'operation-1', label: '查看执行操作' }] }
const summary = { total: 1, succeeded: 1, rejected: 0, failed: 0, uncertain: 0, active: 0 }

function repository(overrides: Partial<AuditRepository> = {}): AuditRepository {
  return { ownsAccount: async () => true, list: async () => ({ items: [event], hasMore: false, summary }),
    find: async () => detail, ...overrides }
}

describe('Stage 12U system audit and execution trace', () => {
  it('rejects invalid HTTP query and path values before reading data', async () => {
    const list = vi.fn(repository().list)
    const find = vi.fn(repository().find)
    const app = Fastify()
    try {
      await app.register(auditRoutes, { prefix: '/api/v4', service: new AuditService(repository({ list, find })), auth: { authenticate: async () => ({ userId: 7 }) } })
      for (const url of [
        '/api/v4/audit/events?page_size=101', '/api/v4/audit/events?page_size=1.5',
        '/api/v4/audit/events?page_size=1&page_size=2', '/api/v4/audit/events?page_size=',
        '/api/v4/audit/events?from=2026-02-30T00:00:00Z', '/api/v4/audit/events?category=unknown',
        '/api/v4/audit/events?account_id=', '/api/v4/audit/events/unknown/record-1',
      ]) {
        const result = await app.inject({ url })
        expect(result.statusCode, url).toBe(400)
        expect(result.json().code).toBe('api_request_invalid')
        expect(result.headers['content-type']).toContain('application/problem+json')
      }
      expect(list).not.toHaveBeenCalled()
      expect(find).not.toHaveBeenCalled()
      const valid = await app.inject({ url: '/api/v4/audit/events?page_size=2' })
      expect(valid.statusCode).toBe(200)
      expect(list.mock.calls[0]?.[1].limit).toBe(2)
    } finally { await app.close() }
  })

  it('authenticates before contract validation and preserves authentication status', async () => {
    const list = vi.fn(repository().list)
    const app = Fastify()
    try {
      await app.register(auditRoutes, { prefix: '/api/v4', service: new AuditService(repository({ list })),
        auth: { authenticate: async () => { throw new AuthError('auth_session_required', 401) } } })
      const result = await app.inject({ url: '/api/v4/audit/events?page_size=invalid' })
      expect(result.statusCode).toBe(401)
      expect(result.json().code).toBe('auth_session_required')
      expect(list).not.toHaveBeenCalled()
    } finally { await app.close() }
  })

  it('fails closed on invalid response data without exposing the rejected value', async () => {
    const app = Fastify()
    try {
      await app.register(auditRoutes, { prefix: '/api/v4', service: new AuditService(repository({
        find: async () => ({ ...detail, event: { ...event, occurredAt: 'internal-secret-invalid-date' } }),
      })), auth: { authenticate: async () => ({ userId: 7 }) } })
      const result = await app.inject({ url: '/api/v4/audit/events/operation/operation-1' })
      expect(result.statusCode).toBe(503)
      expect(result.json().code).toBe('api_response_invalid')
      expect(result.body).not.toContain('internal-secret')
      expect(result.body).not.toMatch(/schemaPath|instancePath|stack/)
    } finally { await app.close() }
  })

  it('normalizes audit identifiers and rejects invalid identifiers before repository access', async () => {
    const find = vi.fn(repository().find)
    const service = new AuditService(repository({ find }))
    await service.detail(7, 'operation', '  operation-1  ')
    expect(find).toHaveBeenCalledWith(7, 'operation', 'operation-1')
    find.mockClear()
    for (const id of ['../secret', 'a b', 'a'.repeat(192), '']) {
      await expect(service.detail(7, 'operation', id)).rejects.toMatchObject({ code: 'audit_source_id_invalid', status: 400 })
    }
    expect(find).not.toHaveBeenCalled()
  })
  it('freezes keyset pages and binds cursors to the complete filter', async () => {
    const service = new AuditService(repository({ list: async () => ({ items: [event], hasMore: true, summary }) }), () => new Date(now))
    const first = await service.events(7, { accountId: '42', category: 'execution', pageSize: 1 })
    expect(first.capturedEnd).toBe(now)
    expect(first.nextCursor).toBeTruthy()
    await expect(service.events(7, { accountId: '42', category: 'risk', cursor: first.nextCursor! }))
      .rejects.toMatchObject({ code: 'audit_cursor_invalid' })
  })

  it('authorizes an account before reading its events', async () => {
    const list = vi.fn()
    const service = new AuditService(repository({ ownsAccount: async () => false, list }))
    await expect(service.events(7, { accountId: '42' })).rejects.toMatchObject({ code: 'audit_account_forbidden', status: 403 })
    expect(list).not.toHaveBeenCalled()
  })

  it('bounds expensive windows and treats invalid page sizes as the safe default', async () => {
    const list = vi.fn(repository().list)
    const service = new AuditService(repository({ list: async (...args) => list(...args) }), () => new Date(now))
    await service.events(7, { pageSize: Number.NaN })
    expect(list.mock.calls[0]?.[1].limit).toBe(50)
    await expect(service.events(7, { from: '2026-01-01T00:00:00.000Z', to: now }))
      .rejects.toMatchObject({ code: 'audit_range_invalid' })
  })

  it('returns normalized summaries and exact trace DTOs without raw payloads', async () => {
    const app = Fastify({ logger: false })
    await app.register(auditRoutes, { prefix: '/api/v4', service: new AuditService(repository(), () => new Date(now)),
      auth: { async authenticate() { return { userId: 7 } } } })
    const page = await app.inject({ method: 'GET', url: '/api/v4/audit/events?account_id=42&category=execution' })
    expect(page.statusCode).toBe(200)
    expect(page.json().data).toMatchObject({ captured_end: now, items: [{ source_kind: 'operation', source_id: 'operation-1' }], summary })
    const record = await app.inject({ method: 'GET', url: '/api/v4/audit/events/operation/operation-1' })
    expect(record.statusCode).toBe(200)
    expect(record.json().data.trace).toEqual(expect.arrayContaining([expect.objectContaining({ stage: 'bridge', source_id: 'command-1' })]))
    expect(record.body).not.toMatch(/payload_json|reasoning|params_json/)
    await app.close()
  })

  it('keeps the audit migration index-only and the SQL projection explicit', async () => {
    const migration = await readFile(new URL('../db/migrations/20260904_014_audit_read_indexes.sql', import.meta.url), 'utf8')
    expect(migration).toContain('idx_ai_trader_user_audit')
    expect(migration).toContain('idx_bridge_command_user_audit')
    expect(migration).not.toMatch(/\b(?:CREATE TABLE|DROP|DELETE|TRUNCATE|UPDATE|INSERT)\b/i)
    const repositorySource = await readFile(new URL('../src/modules/audit/infrastructure/mysql-audit-repository.ts', import.meta.url), 'utf8')
    expect(repositorySource).toContain('UNION ALL')
    expect(repositorySource).toContain('account_trade_records_v4')
    expect(repositorySource).not.toMatch(/SELECT\s+\w+\.\*/i)
  })

  it('publishes HTTP and user-scoped invalidation contracts', async () => {
    const openapi = JSON.parse(await readFile(new URL('../../contracts/openapi-v4.json', import.meta.url), 'utf8'))
    const realtime = JSON.parse(await readFile(new URL('../../contracts/realtime-v4.schema.json', import.meta.url), 'utf8'))
    expect(openapi.paths['/audit/events'].get.operationId).toBe('listAuditEvents')
    expect(openapi.paths['/audit/events/{source_kind}/{source_id}'].get.operationId).toBe('getAuditEvent')
    expect(realtime.$defs.ServerEventType.enum).toContain('audit.changed')
    expect(realtime.$defs.SubscriptionTarget.properties.kind.enum).toContain('audit')
    expect(realtime.$defs.AuditChangedData.required).toEqual(['source_type', 'source_id'])
  })

  it('delivers audit invalidations only to the owning user scope', async () => {
    const sent: unknown[] = []
    const hub = new BrowserRealtimeHub({} as never)
    const stop = await hub.subscribeTargets({ userId: 42, targets: [{ accountId: null, observerChannelId: null, resources: ['audit'],
      afterRevision: { audit: null }, publicTarget: { kind: 'audit', trading_account_id: null, observer_channel_id: null, resource_id: 'all' } }],
      sink: { send(value) { sent.push(value) }, close() { throw new Error('unexpected_close') } } })
    hub.publish({ eventId: 'audit-1', type: 'audit.changed', occurredAt: now, userId: 42, accountId: null,
      terminalInstanceId: null, resource: 'audit', resourceId: 'all', revision: 1, data: { source_type: 'operation.changed', source_id: 'operation-1' } })
    hub.publish({ eventId: 'audit-2', type: 'audit.changed', occurredAt: now, userId: 99, accountId: null,
      terminalInstanceId: null, resource: 'audit', resourceId: 'all', revision: 1, data: { source_type: 'operation.changed', source_id: 'operation-2' } })
    expect(sent).toContainEqual(expect.objectContaining({ type: 'audit.changed', scope: expect.objectContaining({ user_id: '42' }) }))
    expect(sent).not.toContainEqual(expect.objectContaining({ event_id: 'audit-2' }))
    stop?.()
  })

  it('accepts only user-wide audit subscription targets', async () => {
    const sent: unknown[] = []
    const session = new BrowserRealtimeSession(42, new BrowserRealtimeHub({} as never), {
      send(value) { sent.push(value) }, close() { throw new Error('unexpected_close') },
    })
    await session.receive({ v: 4, type: 'subscription.subscribe', request_id: 'audit-user', targets: [{ kind: 'audit',
      trading_account_id: null, observer_channel_id: null, symbol: null, timeframe: null, resource_id: 'all', after_revision: null }] })
    expect(sent).toContainEqual(expect.objectContaining({ type: 'subscription.ready', request_id: 'audit-user' }))
    await session.receive({ v: 4, type: 'subscription.subscribe', request_id: 'audit-account', targets: [{ kind: 'audit',
      trading_account_id: '42', observer_channel_id: null, symbol: null, timeframe: null, resource_id: 'all', after_revision: null }] })
    expect(sent).toContainEqual(expect.objectContaining({ type: 'protocol.error', code: 'realtime_target_invalid' }))
    session.closeSubscriptions()
  })
})
