import { describe, expect, it } from 'vitest'
import type { Pool, PoolConnection } from 'mysql2/promise'
import { createMysqlInferenceRepository } from '../src/modules/inference/composition.js'
import { contentHash, type InferenceRepository } from '../src/modules/inference/index.js'

describe('trader context revision read ownership', () => {
  for (const phase of ['begin', 'complete'] as const) {
    for (const change of ['risk', 'risk_missing', 'subscription', 'paused', 'subscription_missing', 'owner', 'account', 'quote', 'contract', 'positions', 'pending'] as const) {
      it(`${phase} rejects changed context ${change}`, async () => {
        const reasons = {
          risk: ['trader_risk_revision_conflict', 'risk_changed'], risk_missing: ['trader_risk_revision_conflict', 'risk_changed'],
          subscription: ['subscription_revision_conflict', 'subscription_changed'], paused: ['subscription_revision_conflict', 'subscription_changed'],
          subscription_missing: ['subscription_revision_conflict', 'subscription_changed'], owner: ['trader_account_forbidden', 'account_ownership_changed'],
          account: ['trader_account_revision_conflict', 'account_changed'], quote: ['trader_quote_revision_conflict', 'quote_changed'],
          contract: ['trader_contract_revision_conflict', 'contract_changed'], positions: ['trader_projection_revision_conflict', 'positions_changed'],
          pending: ['trader_projection_revision_conflict', 'pending_orders_changed'],
        }
        const calls: string[] = []
        const expiry = new Date(Date.now() + 60000)
        let read = false, stale: unknown[] | undefined, active = false
        const row = { id: 'run', user_id: 7, trading_account_id: '5', subscription_id: '9', subscription_revision: 1,
          market_analysis_id: 'analysis', strategy_id: '2', strategy_version_id: '22', task_mode: 'entry', analysis_revision: 1,
          account_revision: 1, quote_revision: 1, contract_revision: 1, risk_revision: 3, positions_revision: 1, pending_orders_revision: 1,
          revision: 1, status: phase === 'begin' ? 'queued' : 'running', input_snapshot_id: 'snapshot', model_task_id: 'task',
          created_at_utc: new Date(), updated_at_utc: new Date() }
        const connection = {
          async beginTransaction() { active = true }, async rollback() { active = false }, release() {},
          async execute(sql: string, args: unknown[] = []) {
            for (const table of ['account_risk_summaries', 'strategy_subscriptions', 'account_runtime_snapshots', 'market_quotes', 'market_instrument_snapshots', 'trading_projection_revisions']) expect(sql).not.toContain(table)
            if (sql.includes('FROM ai_trader_runs r')) return [[row]]
            if (sql.includes('FROM ai_model_tasks WHERE')) return [[{ status: 'running', fencing_token: 1, deadline_at_utc: expiry }]]
            if (sql.includes('SELECT content_sha256,revision,opportunity,standard_symbol FROM market_analyses')) return [[{ content_sha256: 'a'.repeat(64), revision: 1, opportunity: 'long_setup', standard_symbol: 'XAUUSD' }]]
            if (sql.includes('FROM market_analyses a')) {
              expect(args).toEqual(['analysis'])
              return [[{ strategy_version_id: '11', analysis_revision: 1, valid_until_utc: expiry, standard_symbol: 'XAUUSD', content_sha256: 'a'.repeat(64),
                subscription_revision: 1, subscription_status: 'active', ownership_active: 1,
                account_revision: 1, quote_revision: 1, contract_revision: 1, positions_revision: 1, pending_orders_revision: 1 }]]
            }
            if (sql.startsWith('INSERT INTO trade_decisions ')) { stale = args; throw Error('captured_stale_decision') }
            throw Error('unexpected query')
          },
        } as unknown as PoolConnection
        const unused = () => { throw Error('unexpected dependency') }
        const repository = createMysqlInferenceRepository({ async getConnection() { return connection } } as unknown as Pool,
          unused, unused, unused, {
          subscribers(db) {
            expect(db).toBe(connection); expect(active).toBe(true)
            return { list: unused, readForEvaluation: unused, async readContextVersion(scope) {
              calls.push('subscription')
              expect(scope).toEqual({ subscriptionId: '9', userId: 7, accountId: '5', traderStrategyId: '2', traderStrategyVersionId: '22', analysisStrategyVersionId: '11', symbol: 'XAUUSD' })
              return change === 'subscription_missing' ? null : { revision: change === 'subscription' ? 2 : 1, status: change === 'paused' ? 'paused' : 'active' }
            } }
          },
          inventory(db) {
            expect(db).toBe(connection); expect(active).toBe(true)
            return { async lockAccount(id) { expect(active).toBe(true); expect(id).toBe('5') }, async read() { return { positionsRevision: 1, pendingOrdersRevision: 1, hasPositions: false, hasPendingOrders: false } }, async readRevisions(scope) {
              calls.push('trading'); expect(scope).toEqual({ userId: 7, accountId: '5', symbol: 'XAUUSD' })
              return change === 'owner' ? null : { accountRevision: change === 'account' ? 2 : 1, quoteRevision: change === 'quote' ? 2 : 1,
                contractRevision: change === 'contract' ? 2 : 1, positionsRevision: change === 'positions' ? 2 : 1, pendingOrdersRevision: change === 'pending' ? 2 : 1 }
            } }
          },
          risks(db) {
            expect(db).toBe(connection); expect(active).toBe(true)
            return { async readRevision(user, account) { calls.push('risk'); expect([user, account]).toEqual([7, '5']); read = true; return change === 'risk_missing' ? null : change === 'risk' ? 4 : 3 } }
          } })
        if (phase === 'begin') {
          const snapshot = { kind: 'trader', strategy: { id: '2', versionId: '22' }, account: { id: '5' },
            analysis: { id: 'analysis', contentHash: 'a'.repeat(64) }, taskMode: 'entry', subscriptionRevision: 1, analysisRevision: 1,
            accountRevision: 1, positionsRevision: 1, pendingOrdersRevision: 1, quoteRevision: 1, contractRevision: 1, riskRevision: 3 }
          await expect(repository.beginTrader({ runId: 'run', userId: 7, expectedRevision: 1, snapshot, snapshotHash: contentHash(snapshot) } as unknown as Parameters<InferenceRepository['beginTrader']>[0])).rejects.toMatchObject({ code: reasons[change][0] })
        } else {
          await expect(repository.completeTrader({ runId: 'run', userId: 7, expectedRevision: 1, taskId: 'task', fencingToken: 1,
            result: { action: 'hold', side: null, confidence: 70, summary: 'fixture' } } as unknown as Parameters<InferenceRepository['completeTrader']>[0])).rejects.toThrow(['quote', 'account', 'risk'].includes(change) ? 'unexpected dependency' : 'captured_stale_decision')
          if (['quote', 'account', 'risk'].includes(change)) expect(stale).toBeUndefined()
          else expect(stale!.slice(13, 15)).toEqual(['stale', reasons[change][1]])
        }
        expect(calls).toEqual(['subscription', 'trading', 'risk'])
        expect(read).toBe(true); expect(active).toBe(false)
      })
    }
  }
})
