import Fastify from 'fastify'
import type { Pool } from 'mysql2/promise'
import { expect, it, vi } from 'vitest'
import { createMysqlStrategyService, createStrategyHttp } from '../src/modules/strategies/composition.js'

it('replays metadata changes before CAS while rechecking ownership and retaining the original result', async () => {
  let row = { id: '17', kind: 'analysis', scope: 'user', owner_user_id: 7, status: 'active', active_version_id: '18', name: 'before', description: '', revision: 1 }
  const receipts = new Map<string, Record<string, unknown>>()
  let updates = 0, loseAck = true
  const pool = { execute: vi.fn(async () => { throw Error('outside transaction') }), getConnection: async () => {
    let next = { ...row }, pending: [string, Record<string, unknown>] | undefined
    return { beginTransaction: async () => {}, rollback: async () => {}, release: () => {}, destroy: () => {},
      commit: async () => { row = next; if (pending) receipts.set(...pending); if (loseAck) { loseAck = false; throw Error('lost ack') } },
      execute: async (sql: string, args: unknown[]) => {
        if (sql.startsWith('SELECT id FROM users')) return [[{ id: 7 }], []]
        if (sql.startsWith('SELECT scope')) return [[{ ...next, revision: String(next.revision) }], []]
        if (sql.startsWith('SELECT action')) { const found = receipts.get(String(args[1])); return [found ? [found] : [], []] }
        if (sql.startsWith('UPDATE strategies')) {
          expect(args.slice(2)).toEqual(['17', 7, 1])
          updates++; next = { ...next, name: String(args[0]), description: String(args[1]), revision: next.revision + 1 }
          return [{ affectedRows: 1 }, []]
        }
        if (sql.startsWith('SELECT CAST(s.id')) return [[next], []]
        if (sql.startsWith('SELECT CAST(v.id')) return [[], []]
        if (sql.startsWith('INSERT INTO strategy_write_receipts_v4')) {
          pending = [String(args[1]), { action: args[2], request_sha256: args[3], resource_id: args[4], result_revision: String(args[5]), result_json: args[6], result_sha256: args[7] }]
          return [{ affectedRows: 1 }, []]
        }
        throw Error('unexpected SQL')
      },
    }
  } }
  const app = Fastify()
  await app.register(createStrategyHttp(createMysqlStrategyService(pool as unknown as Pool), {
    authenticate: async () => ({ userId: 7 }), assertWrite: async () => ({ userId: 7 }),
  }))
  const request = { method: 'PATCH' as const, url: '/api/v4/strategies/17', headers: {
    'x-csrf-token': 'csrf-token-123456789', 'idempotency-key': 'strategy-metadata-001', 'if-match': '"1"',
  }, payload: { name: ' after ', description: 'changed' } }
  try {
    expect((await app.inject({ ...request, url: request.url + '?actor=8' })).statusCode).toBe(400)
    const unknown = await app.inject(request)
    expect(unknown.statusCode).toBe(503)
    expect(unknown.json().code).toBe('strategy_commit_unknown')
    expect(row.revision).toBe(2)
    row = { ...row, name: 'later name', revision: 8, status: 'retired' }
    const replay = await app.inject(request)
    expect(replay.statusCode).toBe(200)
    expect(replay.headers.etag).toBe('"2"')
    expect(replay.json().data).toMatchObject({ id: '17', name: 'after', revision: '2', status: 'active' })
    expect(updates).toBe(1)
    const changed = await app.inject({ ...request, headers: { ...request.headers, 'if-match': '"8"' } })
    expect(changed.statusCode).toBe(409)
    expect(changed.json().code).toBe('strategy_idempotency_conflict')
    row = { ...row, status: 'active' }
    const stale = await app.inject({ ...request, headers: { ...request.headers, 'idempotency-key': 'strategy-metadata-002' } })
    expect(stale.statusCode).toBe(412)
    row = { ...row, owner_user_id: 9 }
    const revoked = await app.inject(request)
    expect(revoked.statusCode).toBe(403)
    expect(updates).toBe(1)
    expect(receipts.size).toBe(1)
    expect(pool.execute).not.toHaveBeenCalled()
  } finally { await app.close() }
})
