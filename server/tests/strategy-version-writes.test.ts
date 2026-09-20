import Fastify from 'fastify'
import type { Pool } from 'mysql2/promise'
import { expect, it } from 'vitest'
import { createMysqlStrategyService, createStrategyHttp } from '../src/modules/strategies/composition.js'

it.each(['create', 'publish', 'retire'] as const)('persists and replays %s without repeating a version or subscription mutation', async action => {
  let row = { id: '17', kind: 'analysis', scope: 'user', owner_user_id: 7, name: 'strategy', description: '',
    revision: 1, status: 'active', active_version_id: '18' }
  let receipt: Record<string, unknown> | undefined, loseAck = true
  let versionInserts = 0, updates = 0, subscriptionUpdates = 0, preparations = 0
  const pool = { getConnection: async () => {
    let next = { ...row }, pending: Record<string, unknown> | undefined
    return { beginTransaction: async () => {}, rollback: async () => {}, release: () => {}, destroy: () => {},
      commit: async () => { row = next; receipt = pending ?? receipt; if (loseAck) { loseAck = false; throw Error('ack lost') } },
      execute: async (sql: string, args: unknown[]) => {
        if (sql.startsWith('SELECT id FROM users')) return [[{ id: 7 }], []]
        if (sql.startsWith('SELECT scope')) return [[{ ...next, revision: String(next.revision) }], []]
        if (sql.startsWith('SELECT action')) return [receipt ? [receipt] : [], []]
        if (sql.startsWith('SELECT COALESCE')) { preparations++; return [[{ next_version: 2 }], []] }
        if (sql.startsWith('INSERT INTO strategy_versions')) {
          versionInserts++; expect(args.slice(0, 3)).toEqual(['17', 2, 'analyse'])
          expect(args[4]).toBe('market-analysis-input/v1')
          return [{ insertId: 19 }, []]
        }
        if (sql.startsWith('SELECT id FROM strategy_versions')) { expect(args).toEqual(['18', '17']); return [[{ id: 18 }], []] }
        if (sql.startsWith('SELECT id FROM strategy_subscriptions')) return [[{ id: 27 }], []]
        if (sql.startsWith('UPDATE strategy_subscriptions')) { subscriptionUpdates++; expect(args).toEqual(['17', '18', '17', '18', 27]); return [{ affectedRows: 1 }, []] }
        if (sql.startsWith('UPDATE strategies')) {
          updates++; expect(args.slice(-3)).toEqual(['17', 7, 1]); next.revision++
          if (action === 'retire') next.status = 'retired'
          return [{ affectedRows: 1 }, []]
        }
        if (sql.startsWith('SELECT CAST(s.id')) return [[next], []]
        if (sql.startsWith('SELECT CAST(v.id')) return [[], []]
        if (sql.startsWith('INSERT INTO strategy_write_receipts_v4')) {
          pending = { action: args[2], request_sha256: args[3], resource_id: args[4], result_revision: String(args[5]), result_json: args[6], result_sha256: args[7] }
          return [{ affectedRows: 1 }, []]
        }
        throw Error('unexpected SQL')
      },
    }
  } }
  Object.assign(pool, { execute: async (sql: string, args: unknown[]) => (await pool.getConnection()).execute(sql, args) })
  const service = createMysqlStrategyService(pool as unknown as Pool), app = Fastify()
  await app.register(createStrategyHttp(service, { authenticate: async () => ({ userId: 7 }), assertWrite: async () => ({ userId: 7 }) }))
  const suffix = action === 'create' ? '/versions' : action === 'publish' ? '/versions/18/publish' : '/retire'
  const request = { method: 'POST' as const, url: '/api/v4/strategies/17' + suffix,
    headers: { 'x-csrf-token': 'csrf-token-123456789', 'idempotency-key': 'strategy-version-001', 'if-match': '"1"' },
    ...(action === 'create' ? { payload: { prompt_text: ' analyse ', config: {} } } : {}) }
  try {
    expect((await app.inject({ ...request, url: request.url + '?actor=8' })).statusCode).toBe(400)
    if (action !== 'create') expect((await app.inject({ ...request, payload: { unexpected: true } })).statusCode).toBe(400)
    const unknown = await app.inject(request)
    expect(unknown.statusCode).toBe(503)
    expect(unknown.json().code).toBe('strategy_commit_unknown')
    row = { ...row, revision: 9, status: 'retired' }
    const replay = await app.inject(request)
    expect(replay.statusCode).toBe(action === 'create' ? 201 : 200)
    expect(replay.json().data.revision).toBe('2')
    expect(replay.headers.etag).toBe('"2"')
    expect(updates).toBe(1)
    expect(versionInserts).toBe(action === 'create' ? 1 : 0)
    expect(preparations).toBe(action === 'create' ? 1 : 0)
    expect(subscriptionUpdates).toBe(action === 'publish' ? 1 : 0)
    const conflict = await app.inject({ ...request, headers: { ...request.headers, 'if-match': '"9"' } })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json().code).toBe('strategy_idempotency_conflict')
    row.owner_user_id = 8
    expect((await app.inject(request)).statusCode).toBe(403)
  } finally { await app.close() }
})
