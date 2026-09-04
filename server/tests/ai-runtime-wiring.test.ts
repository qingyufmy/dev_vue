import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  HttpJsonAnalysisModelGateway, HttpJsonTraderModelGateway, loadCredentialKeyring,
  ModelTaskRecovery, MysqlModelUsageLedger, type ModelUsageLedger, type RuntimeModelProfile,
} from '../src/modules/inference/index.js'
import { BullMqOutboxTaskPublisher } from '../src/outbox/index.js'
import type { ClaimedOutboxEvent } from '../src/outbox/application/outbox-ports.js'
import type { RuntimeTaskQueues } from '../src/queue/task-queues.js'

describe('AI runtime wiring', () => {
  it('routes committed outbox wake-ups to isolated queues and skips non-actionable decisions', async () => {
    const calls: Array<{ queue: string; name: string; data: unknown; jobId: string }> = []
    const queue = (name: string) => ({ add: async (job: string, data: unknown, options: { jobId: string }) => {
      calls.push({ queue: name, name: job, data, jobId: options.jobId })
    } })
    const queues = {
      analysis: queue('analysis'), trader: queue('trader'), risk: queue('risk'),
      execution: queue('execution'), bridgeDispatch: queue('bridge'),
    } as unknown as RuntimeTaskQueues
    const publisher = new BullMqOutboxTaskPublisher(queues)
    await publisher.publish(event('analysis.requested', { analysis_id: 'analysis-12345678' }))
    await publisher.publish(event('trader.requested', { trader_run_id: 'trader-12345678' }))
    await publisher.publish(event('trade_decision.created', { decision_id: 'decision-12345678', status: 'proposed' }))
    await publisher.publish(event('trade_decision.created', { decision_id: 'decision-stale-1234', status: 'stale' }))
    await publisher.publish(event('risk.decision.created', { risk_decision_id: 'risk-12345678', user_id: 42, status: 'approved' }))
    await publisher.publish(event('risk.decision.created', { risk_decision_id: 'risk-rejected-1234', user_id: 42, status: 'rejected' }))
    expect(calls).toEqual([
      { queue: 'analysis', name: 'analysis.run', data: { analysisId: 'analysis-12345678' }, jobId: 'event-12345678' },
      { queue: 'trader', name: 'trader.run', data: { traderRunId: 'trader-12345678' }, jobId: 'event-12345678' },
      { queue: 'risk', name: 'risk.review', data: { decisionId: 'decision-12345678' }, jobId: 'event-12345678' },
      { queue: 'execution', name: 'execution.risk-decision.prepare', data: { riskDecisionId: 'risk-12345678', userId: 42 }, jobId: 'event-12345678' },
    ])
  })

  it('uses only the provider-specific structured output shape and never streams', async () => {
    const requests: Array<Record<string, unknown>> = []
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(analysisResult()) } }], usage: { total_tokens: 12 } }), { status: 200 })
    }) as typeof fetch
    const gateway = new HttpJsonAnalysisModelGateway(profile({ provider: 'deepseek', structuredOutput: true }), usageLedger(), request)
    const output = await gateway.analyze({ taskId: 'task-1', attemptId: 'attempt-1', snapshot: analysisSnapshot(), signal: new AbortController().signal })
    expect(output.result).toMatchObject({ marketBias: 'neutral', opportunity: 'none' })
    expect(output.usage).toEqual({ total_tokens: 12 })
    expect(requests[0]).toMatchObject({ stream: false, response_format: { type: 'json_object' } })

    const custom = new HttpJsonAnalysisModelGateway(profile({ provider: 'custom', structuredOutput: true }), usageLedger(), request)
    await custom.analyze({ taskId: 'task-2', attemptId: 'attempt-2', snapshot: analysisSnapshot(), signal: new AbortController().signal })
    expect(requests[1]).not.toHaveProperty('response_format')
  })

  it('reserves usage before network I/O and settles the same reservation', async () => {
    const calls: string[] = []
    const ledger: ModelUsageLedger = {
      async begin(context) { calls.push(`begin:${context.credentialSource}`); return 'reservation-1' },
      async finish(id, completion) { calls.push(`finish:${id}:${completion.status}`) },
    }
    const request = vi.fn(async () => {
      calls.push('fetch')
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(analysisResult()) } }] }), { status: 200 })
    }) as typeof fetch
    const gateway = new HttpJsonAnalysisModelGateway(profile({
      usage: { userId: 42, profileId: 'profile-1', strategyId: 'strategy-1', credentialSource: 'platform_shared', usage: 'auto' },
    }), ledger, request)
    await gateway.analyze({ taskId: 'task-1', attemptId: 'attempt-1', snapshot: analysisSnapshot(), signal: new AbortController().signal })
    expect(calls).toEqual(['begin:platform_shared', 'fetch', 'finish:reservation-1:success'])
  })

  it('does not call the provider when usage admission is rejected', async () => {
    const ledger: ModelUsageLedger = {
      async begin() { throw new Error('daily_request_limit') }, async finish() { throw new Error('unexpected_finish') },
    }
    const request = vi.fn()
    const gateway = new HttpJsonAnalysisModelGateway(profile(), ledger, request as unknown as typeof fetch)
    await expect(gateway.analyze({
      taskId: 'task-1', attemptId: 'attempt-1', snapshot: analysisSnapshot(), signal: new AbortController().signal,
    })).rejects.toThrow('daily_request_limit')
    expect(request).not.toHaveBeenCalled()
  })

  it('keeps a completed model result while surfacing settlement failure to role health', async () => {
    const failures: string[] = []
    const ledger: ModelUsageLedger = {
      async begin() { return 'reservation-1' },
      async finish() { throw new Error('database_unavailable') },
    }
    const request = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(analysisResult()) } }],
    }), { status: 200 })) as typeof fetch
    const gateway = new HttpJsonAnalysisModelGateway(profile(), ledger, request, error => {
      failures.push(error instanceof Error ? error.message : 'unknown')
    })
    await expect(gateway.analyze({
      taskId: 'task-1', attemptId: 'attempt-1', snapshot: analysisSnapshot(), signal: new AbortController().signal,
    })).resolves.toMatchObject({ result: { opportunity: 'none' } })
    expect(failures).toEqual(['database_unavailable'])
  })

  it('serializes platform quota admission on the user row before inserting a reservation', async () => {
    const statements: string[] = []
    const connection = {
      async beginTransaction() { statements.push('BEGIN') },
      async execute(sql: string) {
        statements.push(sql.replace(/\s+/g, ' ').trim())
        if (sql.includes('SELECT u.plan')) return [[{
          plan: 'pro', share_for_manual: 1, share_for_auto: 1, allowed_plans: '["pro"]',
          daily_requests_per_user: 100, daily_tokens_per_user: 500_000,
        }], []]
        if (sql.includes('SELECT COUNT(*)')) return [[{ requests: 4, tokens: 2_000 }], []]
        return [{ insertId: 99 }, []]
      },
      async commit() { statements.push('COMMIT') }, async rollback() {}, release() {},
    }
    const pool = { async getConnection() { return connection } }
    const ledger = new MysqlModelUsageLedger(pool as never)
    await expect(ledger.begin({
      userId: 42, profileId: '7', strategyId: '9', credentialSource: 'platform_shared', usage: 'auto',
    })).resolves.toBe('99')
    expect(statements[1]).toContain('FOR UPDATE')
    expect(statements[2]).toContain("credential_source='platform_shared'")
    expect(statements[3]).toContain('INSERT INTO ai_model_usage_logs')
    expect(statements.at(-1)).toBe('COMMIT')
  })

  it('marks only stale reserved usage rows unknown without replaying a provider call', async () => {
    const statements: Array<{ sql: string; values: unknown[] | undefined }> = []
    const pool = { async execute(sql: string, values?: unknown[]) {
      statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), values })
      return [{ affectedRows: 3 }, []]
    } }
    const before = new Date('2026-09-04T00:00:00.000Z')
    await expect(new MysqlModelUsageLedger(pool as never).recoverAbandoned(before, 50)).resolves.toBe(3)
    expect(statements[0]?.sql).toContain("request_status='reserved'")
    expect(statements[0]?.sql).toContain("accounting_status='usage_unknown'")
    expect(statements[0]?.sql).toContain('ORDER BY id LIMIT 50')
    expect(statements[0]?.sql).toContain('UTC_TIMESTAMP(3)')
    expect(statements[0]?.values).toEqual([before])
  })

  it('supports the Responses output envelope for trader decisions', async () => {
    const request = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      output: [{ content: [{ type: 'output_text', text: JSON.stringify({ action: 'hold', side: null, confidence: 55, summary: '等待', actions: [], reasoning: '暂无机会' }) }] }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }), { status: 200 }))
    const gateway = new HttpJsonTraderModelGateway(profile({ protocol: 'responses', provider: 'volcengine_agent_plan', structuredOutput: true }), usageLedger(), request as unknown as typeof fetch)
    await expect(gateway.decide({ taskId: 'task-1', attemptId: 'attempt-1', snapshot: traderSnapshot(), signal: new AbortController().signal }))
      .resolves.toMatchObject({ result: { action: 'hold' }, usage: { input_tokens: 10 } })
    const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body)) as Record<string, unknown>
    expect(body).toMatchObject({ stream: false, text: { format: { type: 'json_object' } } })
  })

  it('fails closed when the credential keyring is missing or malformed', async () => {
    expect(() => loadCredentialKeyring({})).toThrow('ai_credential_keyring_invalid')
    expect(() => loadCredentialKeyring({ AI_CREDENTIAL_KEYS_JSON: JSON.stringify({ 1: Buffer.alloc(31).toString('base64') }) })).toThrow('ai_credential_keyring_invalid')
    expect(loadCredentialKeyring({ AI_CREDENTIAL_KEYS_JSON: JSON.stringify({ 1: Buffer.alloc(32, 7).toString('base64') }) }).get('1')).toHaveLength(32)
    const source = await readFile(new URL('../src/modules/inference/infrastructure/mysql-model-gateway-resolver.ts', import.meta.url), 'utf8')
    expect(source).toContain('INNER JOIN user_model_defaults')
    expect(source).not.toContain("p.is_default=1")
  })

  it('expires abandoned model work after its absolute deadline without replaying a provider request', async () => {
    const calls: Array<{ now: Date; limit: number }> = []
    const recovery = new ModelTaskRecovery({ async expireOverdue(now, limit) { calls.push({ now, limit }); return 2 } })
    const now = new Date('2026-09-04T00:00:00.000Z')
    await expect(recovery.expireOverdue(now, 25)).resolves.toBe(2)
    expect(calls).toEqual([{ now, limit: 25 }])
    expect(() => recovery.expireOverdue(now, 0)).toThrow('model_recovery_limit_invalid')
    const source = await readFile(new URL('../src/modules/inference/infrastructure/mysql-model-task-recovery-repository.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('.analyze(')
    expect(source).not.toContain('.decide(')
    expect(source).toContain("status='expired'")
  })
})

function event(eventType: ClaimedOutboxEvent['eventType'], payload: Record<string, unknown>): ClaimedOutboxEvent {
  return { id: '1', eventId: 'event-12345678', eventType, occurredAt: '2026-09-04T00:00:00.000Z', payload, attempts: 1 }
}

function profile(overrides: Partial<RuntimeModelProfile> = {}): RuntimeModelProfile {
  return {
    id: 'profile-1', provider: 'deepseek', model: 'deepseek-chat', protocol: 'chat_completions',
    endpoint: 'https://api.example.test/v1/chat/completions', apiKey: 'secret', temperature: 0.3,
    maxTokens: 2_000, timeoutMs: 30_000, maxAttempts: 2, structuredOutput: false,
    allowPrivateEndpoint: true,
    usage: { userId: 42, profileId: 'profile-1', strategyId: 'strategy-1', credentialSource: 'user', usage: 'auto' },
    ...overrides,
  }
}

function usageLedger(): ModelUsageLedger {
  return { async begin() { return '1' }, async finish() {} }
}

function analysisSnapshot() {
  return {
    kind: 'analysis' as const,
    strategy: { id: '1', versionId: '2', promptHash: 'hash', promptText: '只分析客观行情' },
    market: { symbol: 'XAUUSD' }, macro: null, capturedAt: '2026-09-04T00:00:00.000Z',
  }
}

function analysisResult() {
  return {
    marketBias: 'neutral', opportunity: 'none', confidence: 55, summary: '等待', marketRegime: 'range',
    supportingEvidence: [], counterEvidence: [], keyLevels: {}, invalidation: {}, dataGaps: [], analysisBody: '暂无机会',
    analyzedAt: '2026-09-04T00:00:00.000Z', validUntil: '2026-09-04T00:05:00.000Z',
  }
}

function traderSnapshot() {
  return {
    kind: 'trader' as const, taskMode: 'entry' as const,
    strategy: { id: '3', versionId: '4', promptHash: 'hash', promptText: '结合账户决定是否交易' },
    analysis: { id: 'analysis-1', contentHash: 'hash', result: {} }, account: { id: '7' }, positions: [], pendingOrders: [],
    quote: {}, contract: {}, risk: {}, analysisRevision: 1, subscriptionRevision: 1, accountRevision: 1,
    positionsRevision: 1, pendingOrdersRevision: 1, quoteRevision: 1, contractRevision: 1, riskRevision: 1,
    capturedAt: '2026-09-04T00:00:00.000Z',
  }
}
