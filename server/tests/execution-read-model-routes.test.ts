import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { executionDistributionRoutes } from '../src/modules/execution/transport/http/execution-distribution-routes.js'
import { userExecutionCommandRoutes } from '../src/modules/execution/transport/http/user-execution-command-routes.js'
import type { ExecutionDistributionService } from '../src/modules/execution/application/execution-distribution-service.js'
import type { UserExecutionCommandService } from '../src/modules/execution/application/user-execution-command-service.js'

const now = '2026-09-04T08:00:00.000Z'

describe('Stage 12O execution read models', () => {
  it('returns the complete optimistic revision vector and broker limits without exposing the risk policy', async () => {
    const commandContext = vi.fn(async () => ({
      symbol: 'XAUUSD',
      ticket: null,
      context: {
        accountId: '42', observer: false, tradePermission: true,
        currentRevisions: { account: 2, positions: 3, pendingOrders: 4, quote: 5, contract: 6, risk: 7 },
        quote: { symbol: 'XAUUSD', bid: '2500.10', ask: '2500.30', observedAt: now, revision: 5 },
        instrument: { symbol: 'XAUUSD', point: '0.01', tickSize: '0.01', tickValue: '1', volumeMin: '0.01', volumeMax: '100', volumeStep: '0.01', tradeEnabled: true, revision: 6 },
        positions: [], pendingOrders: [], policy: { secret: 'not-on-wire' }, summary: {}, manualRelease: null,
      },
    }))
    const app = Fastify({ logger: false })
    await app.register(userExecutionCommandRoutes, {
      prefix: '/api/v4',
      service: { commandContext } as unknown as UserExecutionCommandService,
      auth: { async authenticate() { return { userId: 7 } }, async assertWrite() { return { userId: 7 } } },
    })

    const result = await app.inject({ method: 'GET', url: '/api/v4/trading-accounts/42/execution-context?symbol=XAUUSD' })
    expect(result.statusCode).toBe(200)
    expect(result.json().data).toEqual({
      account_id: '42', symbol: 'XAUUSD', ticket: null, read_only: false, trade_permission: true,
      expected_state: { account_revision: '2', positions_revision: '3', pending_orders_revision: '4', quote_revision: '5', contract_revision: '6', risk_revision: '7' },
      target_revision: null,
      quote: { bid: '2500.10', ask: '2500.30', observed_at: now },
      instrument: { point: '0.01', tick_size: '0.01', tick_value: '1', volume_min: '0.01', volume_max: '100', volume_step: '0.01', trade_enabled: true },
    })
    expect(JSON.stringify(result.json())).not.toContain('not-on-wire')
    await app.close()
  })

  it('returns incomplete quote and instrument data as null instead of violating the public contract', async () => {
    const commandContext = vi.fn(async () => ({
      symbol: 'XAUUSD', ticket: null,
      context: {
        accountId: '42', observer: false, tradePermission: true,
        currentRevisions: { account: 2, positions: 3, pendingOrders: 4, quote: 0, contract: 6, risk: 7 },
        quote: { symbol: 'XAUUSD', bid: '0', ask: '0', observedAt: now, revision: 0 },
        instrument: { symbol: 'XAUUSD', point: '0.01', tickSize: '0.01', tickValue: '', volumeMin: '0.01', volumeMax: '100', volumeStep: '0.01', tradeEnabled: true, revision: 6 },
        positions: [], pendingOrders: [], policy: {}, summary: {}, manualRelease: null,
      },
    }))
    const app = Fastify({ logger: false })
    await app.register(userExecutionCommandRoutes, {
      prefix: '/api/v4', service: { commandContext } as unknown as UserExecutionCommandService,
      auth: { async authenticate() { return { userId: 7 } }, async assertWrite() { return { userId: 7 } } },
    })

    const result = await app.inject({ method: 'GET', url: '/api/v4/trading-accounts/42/execution-context?symbol=XAUUSD' })
    expect(result.statusCode).toBe(200)
    expect(result.json().data).toMatchObject({ quote: null, instrument: null })
    await app.close()
  })

  it('exposes an estimate before confirmation and a frozen target detail after acceptance', async () => {
    const previewManualOrderDistribution = vi.fn(async () => ({
      strategyId: 'strategy-1', strategyVersionId: 'version-2', strategyRevision: 3, symbol: 'XAUUSD', targetCount: 1,
      targets: [{ accountId: '42', subscriptionId: 'sub-1', tradePermission: true, ready: true, missingResources: [] }],
    }))
    const operation = {
      id: 'op-1', userId: 7, accountId: null, kind: 'execution_distribution', status: 'running', sourceType: 'strategy_distribution', sourceId: 'dist-1',
      idempotencyScope: 'strategy_distribution', idempotencyKey: 'key', requestHash: 'a'.repeat(64), resourceType: 'execution_distribution', resourceId: 'dist-1',
      errorCode: null, acceptedAt: now, updatedAt: now, completedAt: null, revision: 2, intentIds: [], parentOperationId: null, distributionId: 'dist-1', resultSummary: { target_count: 1 },
    }
    const getDistribution = vi.fn(async () => ({
      operation,
      distribution: { id: 'dist-1', operationId: 'op-1', actorUserId: 7, strategyId: 'strategy-1', strategyVersionId: 'version-2', kind: 'manual_order', sourceDistributionId: null, idempotencyKey: 'client-key', requestHash: 'a'.repeat(64), command: { command_type: 'market_order' }, status: 'running', targetCount: 1, resultSummary: { target_count: 1 }, createdAt: now, updatedAt: now, completedAt: null, revision: 2 },
      targets: [{ id: 'target-1', accountId: '42', subscriptionId: 'sub-1', childOperationId: 'child-1', sourceTicket: null, status: 'running', errorCode: null, revision: 2 }],
    }))
    const app = Fastify({ logger: false })
    await app.register(executionDistributionRoutes, {
      prefix: '/api/v4',
      service: { previewManualOrderDistribution, getDistribution } as unknown as ExecutionDistributionService,
      auth: { async authenticate() { return { userId: 7, role: 'admin' } }, async assertWrite() { return { userId: 7, role: 'admin' } } },
    })

    const preview = await app.inject({ method: 'GET', url: '/api/v4/execution-distributions/preview?strategy_id=strategy-1&symbol=XAUUSD' })
    expect(preview.statusCode).toBe(200)
    expect(preview.json().data).toMatchObject({ target_count: 1, strategy_revision: '3', targets: [{ account_id: '42', ready: true }] })
    const detail = await app.inject({ method: 'GET', url: '/api/v4/execution-distributions/dist-1' })
    expect(detail.statusCode).toBe(200)
    expect(detail.json().data).toMatchObject({ id: 'dist-1', revision: '2', targets: [{ id: 'target-1', child_operation_id: 'child-1', status: 'running' }] })
    await app.close()
  })
})
