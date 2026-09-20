import { describe, expect, it } from 'vitest'
import type { Pool, PoolConnection } from 'mysql2/promise'
import { createMysqlInferenceRepository } from '../src/modules/inference/composition.js'
import type { InferenceRepository } from '../src/modules/inference/index.js'

describe('analysis dispatch through module ports', () => {
  for (const scenario of ['entry', 'manage', 'idle', 'revoked'] as const) {
    it(`${scenario} keeps candidate and inventory reads in the completion transaction`, async () => {
      let active = false, committed = false, rolledBack = false
      const inserts: unknown[][] = [], events: unknown[] = []
      const now = new Date()
      const connection = {
        async beginTransaction() { active = true }, async commit() { committed = true; active = false },
        async rollback() { rolledBack = true; active = false }, release() {},
        async execute(sql: string, args: unknown[] = []) {
          expect(active).toBe(true)
          if (sql.includes('FROM ai_analysis_runs r')) return [[{ id: 'run', user_id: 7, strategy_id: '1', strategy_version_id: '11',
            standard_symbol: 'XAUUSD', revision: 2, status: 'running', input_snapshot_id: 'snapshot', model_task_id: 'task', trigger_type: 'scheduled' }]]
          if (sql.includes('FROM ai_model_tasks WHERE')) return [[{ status: 'running', fencing_token: 1, deadline_at_utc: new Date(Date.now() + 60000) }]]
          if (sql.includes('FROM ai_trader_runs')) return [[]]
          if (sql.includes('FROM market_analyses a')) return [[{ id: 'analysis', owner_user_id: 7, strategy_id: '1', strategy_version_id: '11',
            standard_symbol: 'XAUUSD', market_bias: 'neutral', opportunity: 'none', confidence: 70, summary: 'fixture',
            analyzed_at_utc: now, valid_until_utc: now, input_snapshot_hash: 'a'.repeat(64), revision: 1 }]]
          if (/^(INSERT|UPDATE)/.test(sql)) {
            if (sql.startsWith('INSERT INTO market_analyses')) {
              expect(args.slice(-2)).toEqual([now, new Date(now.getTime() + 60000)]
                .map(value => value.toISOString().slice(0, 23).replace('T', ' ')))
            }
            if (sql.startsWith('INSERT INTO ai_trader_runs')) inserts.push(args)
            if (sql.startsWith('INSERT INTO outbox_events')) events.push(args[3])
            return [{ affectedRows: 1 }]
          }
          throw Error('unexpected cross-module SQL')
        },
      } as unknown as PoolConnection
      const unused = () => { throw Error('unexpected dependency') }
      const repository = createMysqlInferenceRepository({ async getConnection() { return connection } } as unknown as Pool,
        () => ({ async read() { throw Error('disabled window') } }), unused, unused, {
          risks: unused,
        subscribers(db) {
            expect(db).toBe(connection); expect(active).toBe(true)
            return { readContextVersion: unused, readForEvaluation: unused, async list(scope) {
              expect(scope).toEqual({ userId: 7, analysisStrategyVersionId: '11', symbol: 'XAUUSD' })
              return [{ id: '9', userId: 7, accountId: '5', revision: 2, traderStrategyId: '2', traderStrategyVersionId: '22',
                timezone: 'UTC', window: { enabled: false } }]
            } }
          },
          inventory(db) {
            expect(db).toBe(connection); expect(active).toBe(true)
            return { lockAccount: unused, readRevisions: unused, async read(scope) {
              expect(scope).toEqual({ userId: 7, accountId: '5', symbol: 'XAUUSD' })
              return scenario === 'revoked' ? null : { positionsRevision: 3, pendingOrdersRevision: 4,
                hasPositions: scenario === 'manage', hasPendingOrders: false }
            } }
          },
        })
      const input = { runId: 'run', userId: 7, expectedRevision: 2, taskId: 'task', attemptId: 'attempt', fencingToken: 1,
        marketAnalysisId: 'analysis', result: { marketBias: 'neutral', opportunity: scenario === 'entry' ? 'long_setup' : 'none',
          confidence: 70, summary: 'fixture', analyzedAt: now.toISOString(), validUntil: new Date(now.getTime() + 60000).toISOString() }, usage: null,
      } as Parameters<InferenceRepository['completeAnalysis']>[0]
      if (scenario === 'revoked') {
        await expect(repository.completeAnalysis(input)).rejects.toMatchObject({ code: 'trader_account_forbidden' })
        expect(rolledBack).toBe(true); expect(committed).toBe(false); expect(inserts).toEqual([])
      } else {
        await repository.completeAnalysis(input)
        expect(committed).toBe(true)
        if (scenario === 'idle') { expect(inserts).toEqual([]); expect(events).toEqual(['market_analysis.created']) }
        else {
          expect(inserts).toHaveLength(1)
          expect(inserts[0]!.slice(1, 12)).toEqual([7, '5', '9', 2, 'analysis', '2', '22', scenario === 'entry' ? 'entry' : 'manage', 3, 4, 'analysis:analysis:subscription:9:revision:2'])
          expect(events).toEqual(['trader.requested', 'market_analysis.created'])
        }
      }
    })
  }
})
