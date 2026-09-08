import { createSubscriptionPreferencesReader } from '../src/modules/strategies/composition.js'
import { createTransactionAccountClock } from '../src/modules/trading/composition.js'
import { describe, expect, it } from 'vitest'
import type { Pool, PoolConnection } from 'mysql2/promise'
import { MysqlInferenceRepository, MysqlTraderWindowGuard, type InferenceRepository, type TraderRun } from '../src/modules/inference/index.js'
import { traderWindowAllows } from '../src/modules/inference/infrastructure/mysql-trader-window.js'

const config = { version: 1, timezone: 'terminal_server', enabled: true, weekdays: [1], windows: [{ start: '22:00', end: '02:00' }], outsideBehavior: 'pause_all' }
const subscription = { user_id: 42, trading_account_id: '7', receive_timezone: 'terminal_server', receive_window_json: config }
const now = new Date('2026-09-07T19:00:00Z')
describe('trader fan-out window', () => {
  it('binds clock reads to the active guard transaction and rolls back untrusted or failed reads', async () => {
    for (const outcome of ['calibrated', 'missing', 'error'] as const) {
      const events: string[] = []
      let active = false
      const connection = {
        async beginTransaction() { active = true; events.push('begin') },
        async commit() { active = false; events.push('commit') },
        async rollback() { active = false; events.push('rollback') },
        release() { events.push('release') },
        async execute(sql: string) {
          expect(active).toBe(true)
          if (sql.includes('FROM strategy_subscriptions')) return [[subscription]]
          expect(sql).toContain('FROM trading_accounts a')
          expect(sql).toContain('FOR SHARE')
          events.push('clock')
          if (outcome === 'error') throw new Error('clock_read_failed')
          return [outcome === 'missing' ? [] : [{ timezone_offset_minutes: 180, clock_status: 'calibrated' }]]
        },
      } as unknown as PoolConnection
      const guard = new MysqlTraderWindowGuard({ getConnection: async () => connection } as unknown as Pool, transaction => {
        expect(transaction).toBe(connection)
        expect(active).toBe(true)
        return createTransactionAccountClock(transaction)
      })
      const run = { subscriptionId: 'sub', userId: 42, tradingAccountId: '7', subscriptionRevision: 4, strategyId: '20', strategyVersionId: '21' } as TraderRun
      if (outcome === 'calibrated') await expect(guard.assertAllowed(run, now)).resolves.toMatch(/^[a-f0-9]{64}$/)
      else await expect(guard.assertAllowed(run, now)).rejects.toThrow(outcome === 'missing' ? 'trader_schedule_closed' : 'clock_read_failed')
      expect(events).toEqual(['begin', 'clock', outcome === 'calibrated' ? 'commit' : 'rollback', 'release'])
    }
  })
  it('rechecks exact subscription revision and releases its transaction on both outcomes', async () => {
    const events: string[] = []
    let present = true
    const connection = {
      async beginTransaction() { events.push('begin') }, async commit() { events.push('commit') },
      async rollback() { events.push('rollback') }, release() { events.push('release') },
      async execute(_sql: string, args: unknown[]) {
        expect(args).toEqual(['sub', 42, '7', 4, '20', '21'])
        return [present ? [{ ...subscription, receive_window_json: { enabled: false } }] : []]
      },
    }
    const guard = new MysqlTraderWindowGuard({ async getConnection() { return connection } } as unknown as Pool, createTransactionAccountClock)
    const run = { subscriptionId: 'sub', userId: 42, tradingAccountId: '7', subscriptionRevision: 4, strategyId: '20', strategyVersionId: '21' } as TraderRun
    await guard.assertAllowed(run, now)
    present = false
    await expect(guard.assertAllowed(run, now)).rejects.toThrow('subscription_revision_conflict')
    expect(events).toEqual(['begin', 'commit', 'release', 'begin', 'rollback', 'release'])
  })
  it('commits completed analysis without creating a trader run or trader outbox outside the window', async () => {
    const writes: string[] = [], events: unknown[] = []
    let committed = false
    const connection = {
      async beginTransaction() {}, async commit() { committed = true }, async rollback() {}, release() {},
      async execute(sql: string, args: unknown[] = []) {
        if (sql.includes('FROM ai_analysis_runs r')) return [[{ id: 'run', user_id: 42, strategy_id: '10', strategy_version_id: '11', standard_symbol: 'XAUUSD', revision: 2, status: 'running', input_snapshot_id: 'snapshot', model_task_id: 'task', trigger_type: 'scheduled' }]]
        if (sql.includes('FROM ai_model_tasks WHERE')) return [[{ id: 'task', status: 'running', fencing_token: 1, deadline_at_utc: new Date(Date.now() + 60000) }]]
        if (sql.includes('FROM strategy_subscriptions s')) return [[{ ...subscription, id: 'sub', revision: 1, trader_strategy_id: '12', trader_strategy_version_id: '13', has_positions: 0, has_pending_orders: 0,
          receive_window_json: config }]]
        if (sql.includes('FROM trading_accounts a')) return [[]]
        if (sql.includes('FROM market_analyses a')) return [[{ id: 'analysis', owner_user_id: 42, strategy_id: '10', strategy_version_id: '11', standard_symbol: 'XAUUSD', market_bias: 'bullish', opportunity: 'long_setup', confidence: '70', summary: 'result', analyzed_at_utc: now, valid_until_utc: now, input_snapshot_hash: 'hash', revision: 1 }]]
        if (/^(INSERT|UPDATE)/.test(sql)) { writes.push(sql); if (sql.includes('INSERT INTO outbox_events')) events.push(args[3]); return [{ affectedRows: 1 }] }
        throw new Error('unexpected_sql')
      },
    }
    const repo = new MysqlInferenceRepository({ async getConnection() { return connection } } as unknown as Pool, createTransactionAccountClock, createSubscriptionPreferencesReader)
    const input = { runId: 'run', userId: 42, expectedRevision: 2, marketAnalysisId: 'analysis', taskId: 'task', attemptId: 'attempt', fencingToken: 1, usage: null,
      result: { opportunity: 'long_setup', marketBias: 'bullish', confidence: 70, summary: 'result', analyzedAt: now.toISOString(), validUntil: now.toISOString() } } as Parameters<InferenceRepository['completeAnalysis']>[0]
    expect((await repo.completeAnalysis(input)).traderRuns).toEqual([])
    expect(committed).toBe(true)
    expect(writes.some(sql => sql.includes('INSERT INTO market_analyses'))).toBe(true)
    expect(writes.some(sql => sql.includes('INSERT INTO ai_trader_runs'))).toBe(false)
    expect(events).toEqual(['market_analysis.created'])
  })
  it('requires an exact clock source, including uniqueness, for an enabled window', async () => {
    let rows: unknown[] = []
    const connection = { async execute(_sql: string, args: unknown[]) { expect(args).toEqual([42, '7']); return [rows] } } as unknown as PoolConnection
    expect(await traderWindowAllows(createTransactionAccountClock(connection), subscription, now)).toBe(false)
    rows = [{ timezone_offset_minutes: 180, clock_status: 'calibrated' }]
    expect(await traderWindowAllows(createTransactionAccountClock(connection), subscription, now)).toBe(true)
    rows.push(rows[0])
    expect(await createTransactionAccountClock(connection).read(42, '7')).toBeNull()
    expect(await traderWindowAllows(createTransactionAccountClock(connection), subscription, now)).toBe(false)
  })
  it('does not turn signals-only outside the window into a trader task', async () => {
    const connection = { async execute() { return [[{ timezone_offset_minutes: 180, clock_status: 'calibrated' }]] } } as unknown as PoolConnection
    expect(await traderWindowAllows(createTransactionAccountClock(connection), { ...subscription, receive_window_json: { ...config, outsideBehavior: 'signals_only' } }, new Date('2026-09-07T23:00:00Z'))).toBe(false)
  })
  it('allows disabled configuration without clock I/O and refuses missing config', async () => {
    const connection = { async execute() { throw new Error('unexpected_clock_read') } } as unknown as PoolConnection
    expect(await traderWindowAllows(createTransactionAccountClock(connection), { ...subscription, receive_timezone: 'UTC', receive_window_json: { enabled: false } }, now)).toBe(true)
    await expect(traderWindowAllows(createTransactionAccountClock(connection), { ...subscription, receive_window_json: null }, now)).rejects.toThrow('subscription_window_invalid')
  })
})
