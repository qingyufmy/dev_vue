import { describe, expect, it } from 'vitest'
import type { Pool, PoolConnection } from 'mysql2/promise'
import { createMysqlInferenceRepository } from '../src/modules/inference/composition.js'
import type { InferenceRepository } from '../src/modules/inference/index.js'

describe('manual trader evaluation module ports', () => {
  for (const scenario of ['create', 'subscription_denied', 'inventory_denied', 'replay'] as const) {
    it(`${scenario} preserves scope, transaction and idempotency`, async () => {
      const input: Parameters<InferenceRepository['requestTraderEvaluation']>[0] = {
        id: 'run-1', userId: 7, tradingAccountId: '5', subscriptionId: '9', subscriptionRevision: 2,
        marketAnalysisId: 'analysis', strategyId: '2', strategyVersionId: '22', idempotencyKey: 'request-1', requestedAt: '2026-09-10T00:00:00.123Z',
      }
      let active = false, committed = false, rolledBack = false, subscriberCalls = 0, inventoryCalls = 0
      const writes: { sql: string; args: unknown[] }[] = []
      const run = { id: 'run-1', user_id: 7, trading_account_id: '5', subscription_id: '9', subscription_revision: 2,
        market_analysis_id: 'analysis', strategy_id: '2', strategy_version_id: '22', task_mode: 'manage', revision: 1,
        status: 'queued', positions_revision: 3, pending_orders_revision: 4, created_at_utc: new Date(), updated_at_utc: new Date() }
      const connection = {
        async beginTransaction() { active = true }, async commit() { committed = true; active = false },
        async rollback() { rolledBack = true; active = false }, release() {},
        async execute(sql: string, args: unknown[] = []) {
          expect(active).toBe(true)
          if (sql.includes('r.idempotency_key=?')) {
            expect(args).toEqual([7, 'request-1'])
            return [scenario === 'replay' ? [run] : []]
          }
          if (sql.includes('FROM market_analyses WHERE')) {
            expect(args).toEqual(['analysis', 7, '2026-09-10 00:00:00.123'])
            return [[{ id: 'analysis', opportunity: 'none', revision: 6, strategy_version_id: '11', standard_symbol: 'XAUUSD' }]]
          }
          if (sql.startsWith('INSERT')) { writes.push({ sql, args }); return [{ affectedRows: 1 }] }
          if (sql.includes('FROM ai_trader_runs r')) return [[run]]
          throw Error('unexpected cross-module SQL')
        },
      } as unknown as PoolConnection
      const unused = () => { throw Error('unexpected dependency') }
      const repository = createMysqlInferenceRepository({ async getConnection() {
        input.userId = 8; input.tradingAccountId = '6'; input.requestedAt = '2026-09-11T00:00:00.000Z'
        return connection
      } } as unknown as Pool, unused, unused, unused, {
        risks: unused,
        subscribers(db) {
          expect(db).toBe(connection); expect(active).toBe(true)
          return { readContextVersion: unused, list: unused, async readForEvaluation(scope) {
            subscriberCalls++
            expect(scope).toEqual({ subscriptionId: '9', userId: 7, accountId: '5', subscriptionRevision: 2,
              traderStrategyId: '2', traderStrategyVersionId: '22', analysisStrategyVersionId: '11', symbol: 'XAUUSD' })
            return scenario === 'subscription_denied' ? null : { id: '9', userId: 7, accountId: '5', revision: 2,
              traderStrategyId: '2', traderStrategyVersionId: '22' }
          } }
        },
        inventory(db) {
          expect(db).toBe(connection); expect(active).toBe(true)
          return { lockAccount: unused, readRevisions: unused, async read(scope) {
            inventoryCalls++
            expect(scope).toEqual({ userId: 7, accountId: '5', symbol: 'XAUUSD' })
            return scenario === 'inventory_denied' ? null : { positionsRevision: 3, pendingOrdersRevision: 4, hasPositions: true, hasPendingOrders: false }
          } }
        },
      })
      if (scenario.endsWith('denied')) {
        await expect(repository.requestTraderEvaluation(input)).rejects.toMatchObject({
          code: scenario === 'subscription_denied' ? 'subscription_revision_conflict' : 'trader_account_forbidden',
        })
        expect(rolledBack).toBe(true); expect(committed).toBe(false); expect(writes).toEqual([])
      } else {
        expect((await repository.requestTraderEvaluation(input)).id).toBe('run-1')
        expect(committed).toBe(true)
        if (scenario === 'replay') { expect(writes).toEqual([]); expect(subscriberCalls + inventoryCalls).toBe(0) }
        else {
          expect(writes).toHaveLength(2)
          expect(writes[0]!.args).toEqual(['run-1', 7, '5', '9', 2, 'analysis', '2', '22', 'manage', 6, 3, 4,
            'request-1', '2026-09-10 00:00:00.123', '2026-09-10 00:00:00.123'])
          expect(writes[1]!.args[3]).toBe('trader.requested')
        }
      }
    })
  }
})
