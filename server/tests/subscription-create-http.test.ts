import Fastify from 'fastify'
import type { Pool } from 'mysql2/promise'
import { expect, it, vi } from 'vitest'
import { createStrategyHttp } from '../src/modules/strategies/composition.js'
import { StrategyService } from '../src/modules/strategies/application/strategy-service.js'
import { MysqlStrategyCatalog } from '../src/modules/strategies/infrastructure/mysql-strategy-catalog.js'

it.each([undefined, { enabled: true, version: 1, timezone: 'terminal_server', weekdays: [1, 2, 3, 4, 5], windows: [{ start: '09:00', end: '18:00' }], outsideBehavior: 'pause_all' }])('replays a subscription and its receive window without recomputing due time: %j', async receiveWindow => {
  let receipt: Record<string, unknown> | undefined, lostAck = true, owned = true, activeVersion = '3'
  const inserts: string[] = [], now = vi.fn(() => new Date('2026-09-09T00:01:00.000Z'))
  let versionReads = 0
  const pool = { execute: vi.fn(async () => { throw Error('outside transaction') }), getConnection: async () => {
    let pending: Record<string, unknown> | undefined, row: Record<string, unknown> | undefined
    return { beginTransaction: async () => {}, rollback: async () => {}, release: () => {}, destroy: () => {},
      commit: async () => { receipt = pending ?? receipt; if (lostAck) { lostAck = false; throw Error('ack lost') } },
      execute: async (sql: string, args: unknown[]) => {
        if (sql.startsWith('SELECT id FROM users')) return [[{ id: 7 }], []]
        if (sql.startsWith('SELECT a.id')) return [owned ? [{ id: 5 }] : [], []]
        if (sql.startsWith('SELECT action')) return [receipt ? [receipt] : [], []]
        if (sql.startsWith('SELECT CAST(s.id AS CHAR) id,s.kind,CAST(s.active_version_id AS CHAR)')) {
          versionReads++; return [[{ id: '2', kind: 'analysis', active_version_id: activeVersion }], []]
        }
        if (sql.startsWith('SELECT id FROM strategy_subscriptions')) return [[], []]
        if (sql.startsWith('INSERT INTO strategy_subscriptions')) {
          inserts.push('subscription')
          row = { id: '9', user_id: args[0], trading_account_id: args[1], standard_symbol: args[2], analysis_strategy_id: args[3],
            analysis_strategy_version_id: args[4], trader_strategy_id: args[5], trader_strategy_version_id: args[6],
            analysis_enabled: args[7], trader_enabled: args[8], trade_send_enabled: args[9], status: args[10], revision: 1,
            created_at_utc: new Date('2026-09-09T00:01:00.000Z'), updated_at_utc: new Date('2026-09-09T00:01:00.000Z'),
            cadence_seconds: 300, receive_timezone: 'UTC', receive_window_json: { enabled: false }, schedule_revision: 1 }
          return [{ insertId: 9 }, []]
        }
        if (sql.startsWith('INSERT INTO subscription_schedules')) {
          inserts.push('schedule'); row!.receive_timezone = args[1]; row!.receive_window_json = JSON.parse(String(args[2]))
          row!.next_due_at_utc = args[3]; return [{ affectedRows: 1 }, []]
        }
        if (sql.startsWith('INSERT INTO subscription_execution_preferences')) { inserts.push('preferences'); return [{ affectedRows: 1 }, []] }
        if (sql.startsWith('SELECT CAST(s.id AS CHAR) id,s.user_id')) return [[row], []]
        if (sql.startsWith('INSERT INTO strategy_write_receipts_v4')) {
          inserts.push('receipt')
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
  const request = { method: 'POST' as const, url: '/api/v4/strategy-subscriptions',
    headers: { 'x-csrf-token': 'csrf-token-123456789', 'idempotency-key': 'subscription-create-001' },
    payload: { trading_account_id: '5', symbol: 'XAUUSD', analysis_strategy_id: '2', ...(receiveWindow ? { receive_window: receiveWindow } : {}) } }
  try {
    expect((await app.inject({ ...request, payload: { ...request.payload, next_due_at: 'tomorrow' } })).statusCode).toBe(400)
    expect((await app.inject({ ...request, payload: { ...request.payload, receive_window: { enabled: true } } })).statusCode).toBe(400)
    const unknown = await app.inject(request)
    expect(unknown.statusCode).toBe(503)
    expect(unknown.json().code).toBe('strategy_commit_unknown')
    activeVersion = '33'; now.mockImplementation(() => new Date('2026-09-10T12:00:00.000Z'))
    const replay = await app.inject(request)
    expect(replay.statusCode).toBe(201)
    expect(replay.json().data).toMatchObject({ id: '9', analysis_strategy_version_id: '3', revision: '1',
      schedule: { next_due_at: '2026-09-09T00:05:00.000Z', receive_window: receiveWindow ?? { enabled: false }, receive_timezone: receiveWindow ? 'terminal_server' : 'UTC' } })
    expect(inserts).toEqual(['subscription', 'schedule', 'preferences', 'receipt'])
    expect(now).toHaveBeenCalledTimes(1)
    expect(versionReads).toBe(1)
    const conflict = await app.inject({ ...request, payload: { ...request.payload, analysis_enabled: true } })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json().code).toBe('strategy_idempotency_conflict')
    owned = false
    expect((await app.inject(request)).statusCode).toBe(403)
    expect(pool.execute).not.toHaveBeenCalled()
  } finally { await app.close() }
})
