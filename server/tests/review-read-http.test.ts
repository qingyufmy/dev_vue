import { createHash } from 'node:crypto'
import { ReviewError } from '../src/modules/reviews/domain/review.js'
import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { createReviewHttp } from '../src/modules/reviews/composition.js'
import { AuthError } from '../src/modules/auth/index.js'
import type { ReviewService } from '../src/modules/reviews/application/review-service.js'
import { createHttpContractValidator } from '../src/transport/http-contract.js'
import { httpRuntimeContracts } from '../src/transport/generated/http-contracts.js'

const now = '2026-09-09T08:00:00.000Z'
const summary = { id: 'case-1', kind: 'manual', userId: 7, tradingAccountId: 'account-1', accountLabel: 'Demo',
  standardSymbol: 'XAUUSD', subscriptionId: null, subscriptionRevision: null, analysisStrategyId: 'strategy-1',
  analysisStrategyName: '分析策略', traderStrategyId: null, traderStrategyName: null, terminalPeriodStart: now,
  terminalPeriodEnd: now, terminalTimezoneOffsetMinutes: 180, status: 'queued', evidenceStatus: 'complete',
  evidenceRevision: 1, evidenceHash: 'a'.repeat(64), currentVersionId: null, confirmedVersionId: null, updatedAt: now, revision: 1 }
const memory = { id: 'memory-1', strategyId: 'strategy-1', strategyName: '分析策略', strategyKind: 'analysis',
  ownerUserId: 7, mode: 'shadow', status: 'active', currentVersionNumber: 1, pendingCount: 0, updatedAt: now,
  revision: 1, currentRevisionId: null, contentText: '', contentHash: null, maxContextTokens: 1000 }

async function fixture() {
  const service = { cases: vi.fn(async () => [summary]), detail: vi.fn(async () => ({ summary, currentVersion: null, sources: [], currentJob: null, returnReason: null })),
    manualCandidates: vi.fn(async () => [{ id: 'candidate-1', tradingAccountId: 'account-1', accountLabel: 'Demo',
      ticket: '123', positionId: null, symbol: 'XAUUSD', side: 'buy', volume: '0.01', openedAt: now, closedAt: now,
      netProfit: '1.25', terminalTimezoneOffsetMinutes: 180, sourceClassification: 'manual', eligibilityStatus: 'eligible',
      selectionToken: 'a'.repeat(32), selectionExpiresAt: now, revision: 1 }]),
    memories: vi.fn(async () => [memory]), memory: vi.fn(async () => memory),
    memoryUpdates: vi.fn(async () => [{ id: 'update-1', libraryId: 'memory-1', sourceReviewCaseId: 'case-1',
      sourceReviewVersionId: 'version-1', updateKind: 'short_term', status: 'awaiting_confirmation', expectedLibraryRevision: 1,
      proposal: { memoryKey: 'entry.confirmation', title: '确认', content: '保留证据', evidenceRefs: ['analysis:1'] },
      diffPreviewText: '新增', conflicts: [], createdAt: now, revision: 1 }]) }
  const authenticate = vi.fn(async () => ({ userId: 7 }))
  const app = Fastify()
  await app.register(createReviewHttp(service as unknown as ReviewService, { authenticate, assertWrite: authenticate }))
  return { app, service, authenticate }
}

it('validates all six review reads and keeps ETags only on successful details', async () => {
  const { app, service } = await fixture()
  try {
    for (const path of ['/review-cases?kind=manual&page_size=5', '/review-cases/case-1', '/manual-review-candidates',
      '/strategy-memories', '/strategy-memories/memory-1', '/strategy-memories/memory-1/updates']) {
      const result = await app.inject('/api/v4' + path)
      expect(result.statusCode, result.body).toBe(200)
      expect(result.headers['cache-control']).toBe('no-store')
    }
    expect(service.cases).toHaveBeenCalledWith(7, { kind: 'manual', limit: 5 })
    expect(service.memory).toHaveBeenCalledWith(7, 'memory-1')
    const contract = createHttpContractValidator(httpRuntimeContracts, ['getStrategyMemory', 'listStrategyMemories'])
    const detailBody = (await app.inject('/api/v4/strategy-memories/memory-1')).json()
    expect(() => contract.response('getStrategyMemory', { ...detailBody, data: { ...detailBody.data, unknown: true } })).toThrow('api_response_invalid')
    const listBody = (await app.inject('/api/v4/strategy-memories')).json()
    expect(() => contract.response('listStrategyMemories', { ...listBody, data: { items: [{ ...listBody.data.items[0], content_text: 'detail only' }] } })).toThrow('api_response_invalid')
    service.memory.mockResolvedValueOnce({ ...memory, maxContextTokens: -1 })
    const malformed = await app.inject('/api/v4/strategy-memories/memory-1')
    expect(malformed.statusCode).toBe(503)
    expect(malformed.json().code).toBe('api_response_invalid')
    expect(malformed.headers.etag).toBeUndefined()
    expect(malformed.headers['content-type']).toContain('application/problem+json')
  } finally { await app.close() }
})

it('accepts and returns the distinct system single-trade review kind', async () => {
  const { app, service } = await fixture()
  try {
    service.cases.mockResolvedValueOnce([{ ...summary, kind: 'trade' }])
    const result = await app.inject('/api/v4/review-cases?kind=trade')
    expect(result.statusCode, result.body).toBe(200)
    expect(result.json().data.items[0].kind).toBe('trade')
    expect(service.cases).toHaveBeenCalledWith(7, { kind: 'trade', limit: 50 })
  } finally { await app.close() }
})

it('rejects invalid filters before service access but authenticates before input validation', async () => {
  const { app, service, authenticate } = await fixture()
  try {
    for (const path of ['/review-cases?page_size=0', '/review-cases?page_size=1e2', '/review-cases?kind=unknown',
      '/review-cases?kind=daily&kind=monthly', '/manual-review-candidates?page_size=101', '/strategy-memories?user_id=8',
      '/strategy-memories/memory-1/updates?cursor=bad', '/review-cases/case-1?unknown=1']) {
      expect((await app.inject('/api/v4' + path)).statusCode).toBe(400)
    }
    for (const method of Object.values(service)) expect(method).not.toHaveBeenCalled()
    authenticate.mockRejectedValueOnce(new AuthError('auth_session_required', 401))
    const denied = await app.inject('/api/v4/review-cases?page_size=bad')
    expect(denied.statusCode).toBe(401)
    expect(denied.json().code).toBe('auth_session_required')
    expect(denied.headers['cache-control']).toBe('no-store')
  } finally { await app.close() }
})

it('does not leak repository errors or malformed list rows', async () => {
  const { app, service } = await fixture()
  try {
    service.cases.mockRejectedValueOnce(new Error('private SQL credentials'))
    const failed = await app.inject('/api/v4/review-cases')
    expect(failed.statusCode).toBe(503)
    expect(failed.body).not.toContain('private SQL')
    service.cases.mockResolvedValueOnce([{ ...summary, status: 'not-a-status' }])
    expect((await app.inject('/api/v4/review-cases')).json().code).toBe('api_response_invalid')
  } finally { await app.close() }
})

it('does not advertise an unknown write commit as retryable', async () => {
  const app = Fastify()
  const returnForChanges = vi.fn(async () => { throw new ReviewError('review_commit_unknown', 503) })
  const authenticate = async () => ({ userId: 7 })
  await app.register(createReviewHttp({ returnForChanges } as unknown as ReviewService, { authenticate, assertWrite: authenticate }))
  try {
    const result = await app.inject({ method: 'POST', url: '/api/v4/review-cases/case-1/return', headers: { 'if-match': '"1"', 'x-csrf-token': 'c'.repeat(32), 'idempotency-key': 'review-return-0001' }, payload: { reason: 'more evidence' } })
    expect(result.statusCode).toBe(503)
    expect(result.json()).toMatchObject({ code: 'review_commit_unknown', retryable: false })
    expect(returnForChanges).toHaveBeenCalledOnce()
  } finally { await app.close() }
})

const writeCases = [
  { path: '/review-cases/case-1/generations', method: 'requestGeneration', payload: { mode: 'retry' }, status: 202 },
  { path: '/review-cases/case-1/versions', method: 'createVersion', payload: { content: {
    schema_version: 'review.v4.1', conclusion: 'mixed', headline: '复盘完成', summary: '分析有效，执行一般',
    metrics: { net_profit: '3.2', trade_count: 1, win_rate_percent: '100', profit_factor: '1.2' }, trade_episodes: [],
    roles: Object.fromEntries(['analyst', 'trader', 'risk', 'execution'].map(role => [role, { assessment: 'effective', summary: '证据摘要', evidence_refs: ['market_analysis:analysis-1'] }])),
    counterexamples: [], memory_candidates: [], evidence_refs: ['market_analysis:analysis-1'], full_analysis_text: '完整复盘正文',
  } }, status: 201 },
  { path: '/review-cases/case-1/confirm', method: 'confirm', payload: { version_id: 'version-1' }, status: 200 },
  { path: '/review-cases/case-1/return', method: 'returnForChanges', payload: { reason: 'more evidence' }, status: 200 },
  { path: '/manual-review-cases', method: 'createManualCase', payload: { candidate_ids: ['candidate-1'], selection_tokens: ['a'.repeat(32)], strategy_id: 'strategy-1' }, status: 202 },
  { path: '/strategy-memory-updates/update-1/decision', method: 'decideMemoryUpdate', payload: { decision: 'accept' }, status: 200 },
]
it.each(writeCases)('validates $method before effects and after result projection', async ({ path, method, payload, status }) => {
  const app = Fastify()
  const result = method === 'decideMemoryUpdate' ? {
    id: 'update-1', libraryId: 'memory-1', sourceReviewCaseId: 'case-1', sourceReviewVersionId: 'version-1',
    updateKind: 'short_term', status: 'merged', expectedLibraryRevision: 1,
    proposal: { memoryKey: 'entry.confirmation', title: '确认', content: '保留证据', evidenceRefs: ['analysis:1'] },
    diffPreviewText: '新增', conflicts: [], createdAt: now, revision: 2,
  } : { summary, currentVersion: null, sources: [], currentJob: null, returnReason: null }
  const write = vi.fn(async (): Promise<unknown> => result)
  const authenticate = vi.fn(async () => ({ userId: 7 }))
  await app.register(createReviewHttp({ [method]: write } as unknown as ReviewService, { authenticate, assertWrite: authenticate }))
  const headers = { 'if-match': '"1"', 'x-csrf-token': 'c'.repeat(32), 'idempotency-key': 'review-test-key-0001' }
  try {
    for (const bad of [{ url: '/api/v4' + path + '?user_id=8', payload }, { url: '/api/v4' + path, payload: { ...payload, user_id: '8' } }]) {
      const response = await app.inject({ method: 'POST', ...bad, headers })
      expect(response.statusCode, response.body).toBe(400)
      expect(response.headers['content-type']).toContain('application/problem+json')
      expect(response.headers['cache-control']).toBe('no-store')
    }
    expect(write).not.toHaveBeenCalled()
    const valid = await app.inject({ method: 'POST', url: '/api/v4' + path, payload, headers })
    expect(valid.statusCode, valid.body).toBe(status)
    expect(valid.headers.etag).toBe(method === 'decideMemoryUpdate' ? '"2"' : '"1"')
    expect(write).toHaveBeenCalledOnce()
    write.mockResolvedValueOnce({ secret: 'private-result' })
    const broken = await app.inject({ method: 'POST', url: '/api/v4' + path, payload, headers })
    expect(broken.statusCode, broken.body).toBe(503)
    expect(broken.json()).toMatchObject({ code: 'review_result_unknown', retryable: false })
    expect(broken.headers.etag).toBeUndefined()
    expect(broken.body).not.toContain('private-result')
    authenticate.mockRejectedValueOnce(new AuthError('auth_session_required', 401))
    const denied = await app.inject({ method: 'POST', url: '/api/v4' + path, payload, headers })
    expect(denied.statusCode, denied.body).toBe(401)
    expect(write).toHaveBeenCalledTimes(2)
  } finally { await app.close() }
})

it('serves historical text without synthesizing modern assessments', async () => {
  const { app, service } = await fixture()
  const rawText = ' {"period_summary":"历史摘要"}\r\n'
  try {
    service.detail.mockResolvedValueOnce({ summary: { ...summary, currentVersionId: 'v1' }, currentVersion: {
      id: 'v1', caseId: summary.id, versionNumber: 1, authorKind: 'ai', conclusion: null, createdAt: now,
      content: { schemaVersion: 'review.legacy.v1', sourceTable: 'period_review_versions', sourceId: '1',
        sourceSha256: createHash('sha256').update(rawText).digest('hex'), originalContentHash: null, rawText },
    }, sources: [], currentJob: null, returnReason: null } as never)
    const response = await app.inject('/api/v4/review-cases/case-1')
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().data.current_version.content.raw_text).toBe(rawText)
    expect(response.json().data.current_version.conclusion).toBeNull()
    expect(response.json().data.current_version.content.roles).toBeUndefined()
  } finally { await app.close() }
})

it('reads archived cases without implying that the historical job is running', async () => {
  const { app, service } = await fixture()
  try {
    service.cases.mockResolvedValueOnce([{ ...summary, status: 'archived' }])
    const response = await app.inject('/api/v4/review-cases')
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().data.items[0].status).toBe('archived')
  } finally { await app.close() }
})
