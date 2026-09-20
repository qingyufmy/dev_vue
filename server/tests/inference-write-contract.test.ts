import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { AuthError } from '../src/modules/auth/index.js'
import { InferenceError } from '../src/modules/inference/domain/inference.js'
import { inferenceRoutes, type InferenceRoutesOptions } from '../src/modules/inference/transport/http/inference-routes.js'

for (const evaluation of [false, true]) {
  it(`validates ${evaluation ? 'evaluation' : 'analysis'} submission and retains cooldown and uncertain outcomes`, async () => {
    const result = { id: 'run1', strategyId: 's1', strategyVersionId: 'v1', symbol: 'XAUUSD', trigger: 'manual', status: 'queued',
      createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:00:00.000Z', revision: 1,
      marketAnalysisId: 'a1', tradingAccountId: '42', taskMode: 'entry' }
    const execute = vi.fn().mockResolvedValue(result), assertWrite = vi.fn().mockResolvedValue({ userId: 7 })
    const app = Fastify()
    await app.register(inferenceRoutes, { prefix: '/api/v4',
      service: { requestManualAnalysis: execute, requestAccountEvaluation: execute } as unknown as InferenceRoutesOptions['service'],
      analysisList: { async list() { return { items: [], nextCursor: null } } },
      auth: { assertWrite, authenticate: assertWrite } })
    const body = evaluation ? { trading_account_id: '42', subscription_id: 'sub1', subscription_revision: '3', trader_strategy_id: 's1', trader_strategy_version_id: 'v1' }
      : { strategy_id: 's1', symbol: 'XAUUSD', mode: 'manual' }
    const send = (payload: unknown = body, headers = {}) => app.inject({ method: 'POST',
      url: '/api/v4' + (evaluation ? '/market-analyses/a1/trader-evaluations' : '/analysis-jobs'), payload: payload as object,
      headers: { 'idempotency-key': 'inference-request-0001', 'x-csrf-token': 'csrf-token-1234567890', ...headers } })
    try {
      assertWrite.mockRejectedValueOnce(new AuthError('csrf_invalid', 403))
      expect((await send({})).statusCode).toBe(403)
      expect((await send({ ...body, actor: 9 })).statusCode).toBe(400)
      expect((await send(body, { 'x-csrf-token': 'short' })).statusCode).toBe(400)
      expect(execute).not.toHaveBeenCalled()
      expect((await send()).statusCode).toBe(202)
      expect(execute.mock.calls[0]?.[0]).toBe(7)
      expect(execute.mock.calls[0]?.at(-1)).toBe('inference-request-0001')
      execute.mockRejectedValueOnce(new InferenceError('analysis_cooldown', 429, 180000))
      const cooldown = await send()
      expect(cooldown.statusCode).toBe(429); expect(cooldown.json().retry_after_ms).toBe(180000)
      expect(cooldown.headers['cache-control']).toBe('no-store')
      execute.mockResolvedValueOnce({ ...result, status: 'private-invalid' })
      const unknown = await send()
      expect(unknown.statusCode).toBe(503); expect(unknown.json().code).toBe('inference_commit_unknown')
      expect(unknown.body).not.toContain('private-invalid')
      expect(execute).toHaveBeenCalledTimes(3)
    } finally { await app.close() }
  })
}
