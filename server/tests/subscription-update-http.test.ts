import Fastify from 'fastify'
import type { Pool } from 'mysql2/promise'
import { expect, it, vi } from 'vitest'
import { createStrategyHttp } from '../src/modules/strategies/composition.js'
import { StrategyService } from '../src/modules/strategies/application/strategy-service.js'
import { MysqlStrategyCatalog } from '../src/modules/strategies/infrastructure/mysql-strategy-catalog.js'

it.each(['draft', 'retired', 'forbidden', 'wrong_kind', 'trader_draft'] as const)(
  'rejects activation with %s even when strategy IDs are unchanged', async mode => {
    const rollback = vi.fn(), reads: string[] = [], writes = vi.fn()
    const row = { id: '9', user_id: 7, trading_account_id: '5', standard_symbol: 'XAUUSD', analysis_strategy_id: '2',
      analysis_strategy_version_id: '3', trader_strategy_id: '4', trader_strategy_version_id: '5',
      analysis_enabled: 0, trader_enabled: 0, trade_send_enabled: 0, status: 'paused', revision: 1,
      created_at_utc: new Date(), updated_at_utc: new Date(), cadence_seconds: 300, receive_timezone: 'terminal_server',
      receive_window_json: { enabled: false }, schedule_revision: 1, next_due_at_utc: null }
    const connection = { beginTransaction: async () => {}, commit: writes, rollback, release: () => {},
      execute: async (sql: string, args: unknown[]) => {
        if (sql.startsWith('SELECT id FROM users')) return [[{ id: 7 }], []]
        if (sql.startsWith('SELECT a.id')) return [[{ id: 5 }], []]
        if (sql.startsWith('SELECT action')) return [[], []]
        if (sql.startsWith('SELECT CAST(s.id AS CHAR) id,s.user_id')) return [[row], []]
        if (sql.startsWith('SELECT CAST(s.id AS CHAR) id,s.kind,')) {
          expect(sql).toContain("s.status='active'"); expect(sql).toContain('FOR SHARE')
          reads.push(String(args[0]))
          if (mode === 'trader_draft' && args[0] === '2') return [[{ id: '2', kind: 'analysis', active_version_id: '3' }], []]
          if (mode === 'wrong_kind') return [[{ id: '2', kind: 'trader', active_version_id: '3' }], []]
          return [[], []]
        }
        writes(); throw Error('unexpected write')
      } }
    const pool = { getConnection: async () => connection } as unknown as Pool
    const app = Fastify()
    await app.register(createStrategyHttp(new StrategyService(new MysqlStrategyCatalog(pool)), {
      authenticate: async () => ({ userId: 7 }), assertWrite: async () => ({ userId: 7 }),
    }))
    try {
      const response = await app.inject({ method: 'PATCH', url: '/api/v4/strategy-subscriptions/9',
        headers: { 'x-csrf-token': 'csrf-token-123456789', 'idempotency-key': 'subscription-enable-001', 'if-match': '"1"' },
        payload: { status: 'active', analysis_enabled: true, trader_enabled: mode === 'trader_draft' } })
      expect(response.statusCode).toBe(409)
      expect(response.json().code).toBe('strategy_subscription_strategy_unavailable')
      expect(reads).toEqual(mode === 'trader_draft' ? ['2', '4'] : ['2'])
      expect(writes).not.toHaveBeenCalled(); expect(rollback).toHaveBeenCalledTimes(1)
    } finally { await app.close() }
  })

it.each(['resume', 'refresh_version', 'change', 'end', 'missing_schedule', 'raced'] as const)('keeps subscription %s transactional and replayable', async mode => {
  let row = { id: '9', user_id: 7, trading_account_id: '5', standard_symbol: 'XAUUSD', analysis_strategy_id: '2',
    analysis_strategy_version_id: '3', trader_strategy_id: null, trader_strategy_version_id: null,
    analysis_enabled: 1, trader_enabled: 0, trade_send_enabled: 0, status: mode === 'resume' || mode === 'refresh_version' ? 'paused' : 'active', revision: 1,
    created_at_utc: new Date('2026-09-09T00:00:00.000Z'), updated_at_utc: new Date('2026-09-09T00:00:00.000Z'),
    cadence_seconds: 300, receive_timezone: 'UTC', receive_window_json: { enabled: false }, schedule_revision: 1,
    next_due_at_utc: null as string | null }
  let receipt: Record<string, unknown> | undefined, lostAck = true, owned = true, writes = 0, versionReads = 0
  const now = vi.fn(() => new Date('2026-09-09T00:01:00.000Z')), rollback = vi.fn()
  const pool = { execute: vi.fn(async () => { throw Error('outside transaction') }), getConnection: async () => {
    let next = { ...row }, pending: Record<string, unknown> | undefined
    return { beginTransaction: async () => {}, rollback, release: () => {}, destroy: () => {},
      commit: async () => { row = next; receipt = pending ?? receipt; if (lostAck) { lostAck = false; throw Error('ack lost') } },
      execute: async (sql: string, args: unknown[]) => {
        if (sql.startsWith('SELECT id FROM users')) return [[{ id: 7 }], []]
        if (sql.startsWith('SELECT a.id')) return [owned ? [{ id: 5 }] : [], []]
        if (sql.startsWith('SELECT action')) return [receipt ? [receipt] : [], []]
        if (sql.startsWith('SELECT CAST(s.id AS CHAR) id,s.kind,')) {
          versionReads++; expect(args).toEqual([mode === 'change' ? '4' : '2', 7])
          return [[{ id: String(args[0]), kind: 'analysis', active_version_id: mode === 'refresh_version' ? '77' : mode === 'change' ? '44' : '3' }], []]
        }
        if (sql.startsWith('SELECT CAST(s.id AS CHAR) id,s.user_id')) {
          if (mode === 'raced' && sql.endsWith('FOR UPDATE')) next.revision++
          return [[{ ...next }], []]
        }
        if (sql.startsWith('UPDATE strategy_subscriptions')) {
          writes++; expect(args.slice(-3)).toEqual(['9', 7, 1])
          next = { ...next, standard_symbol: String(args[0]), analysis_strategy_id: String(args[1]), analysis_strategy_version_id: String(args[2]),
            analysis_enabled: Number(args[5]), trader_enabled: Number(args[6]), trade_send_enabled: Number(args[7]), status: String(args[8]), revision: 2 }
          return [{ affectedRows: 1 }, []]
        }
        if (sql.startsWith('UPDATE subscription_schedules')) {
          if (mode === 'missing_schedule') return [{ affectedRows: 0 }, []]
          next.receive_timezone = String(args[0]); next.receive_window_json = JSON.parse(String(args[1]))
          next.next_due_at_utc = args[2] as string | null; next.schedule_revision++
          return [{ affectedRows: 1 }, []]
        }
        if (sql.startsWith('INSERT INTO strategy_write_receipts_v4')) {
          pending = { action: args[2], request_sha256: args[3], resource_id: args[4], result_revision: String(args[5]), result_json: args[6], result_sha256: args[7] }
          return [{ affectedRows: 1 }, []]
        }
        throw Error('unexpected SQL')
      },
    }
  } }
  const app = Fastify()
  await app.register(createStrategyHttp(new StrategyService(new MysqlStrategyCatalog(pool as unknown as Pool), now), {
    authenticate: async () => ({ userId: 7 }), assertWrite: async () => ({ userId: 7 }),
  }))
  const payload = mode === 'refresh_version' ? { status: 'active', analysis_enabled: true } : mode === 'change' ? { analysis_strategy_id: '4' } : { status: mode === 'resume' ? 'active' : mode === 'end' ? 'ended' : 'paused' }
  const request = { method: 'PATCH' as const, url: '/api/v4/strategy-subscriptions/9', payload,
    headers: { 'x-csrf-token': 'csrf-token-123456789', 'idempotency-key': 'subscription-update-001', 'if-match': '"1"' } }
  try {
    expect((await app.inject({ ...request, payload: { next_due_at: 'tomorrow' } })).statusCode).toBe(400)
    expect((await app.inject({ ...request, payload: {} })).statusCode).toBe(422)
    const first = await app.inject(request)
    if (mode === 'missing_schedule' || mode === 'raced') {
      expect(first.json().code).toBe(mode === 'missing_schedule' ? 'strategy_subscription_schedule_missing' : 'strategy_subscription_revision_conflict')
      expect(first.statusCode).toBe(mode === 'missing_schedule' ? 503 : 412)
      expect(rollback).toHaveBeenCalledTimes(1)
      expect(receipt).toBeUndefined()
      expect(row.revision).toBe(1)
      return
    }
    expect(first.statusCode).toBe(503)
    expect(first.json().code).toBe('strategy_commit_unknown')
    row = { ...row, status: 'ended', revision: 9, analysis_strategy_version_id: '99' }
    now.mockImplementation(() => new Date('2026-09-10T12:00:00.000Z'))
    const replay = await app.inject(request)
    expect(replay.statusCode).toBe(200)
    expect(replay.json().data).toMatchObject({ revision: '2', analysis_strategy_version_id: mode === 'refresh_version' ? '77' : mode === 'change' ? '44' : '3',
      schedule: { next_due_at: mode === 'end' ? null : '2026-09-09T00:05:00.000Z' } })
    expect(writes).toBe(1)
    expect(now).toHaveBeenCalledTimes(mode === 'end' ? 0 : 1)
    expect(versionReads).toBe(mode === 'refresh_version' || mode === 'change' || mode === 'resume' ? 1 : 0)
    expect((await app.inject({ ...request, headers: { ...request.headers, 'if-match': '"9"' } })).statusCode).toBe(409)
    owned = false
    expect((await app.inject(request)).statusCode).toBe(403)
    expect(pool.execute).not.toHaveBeenCalled()
  } finally { await app.close() }
})
