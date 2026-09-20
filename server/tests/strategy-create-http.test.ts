import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { createStrategyHttp, createMysqlStrategyService } from '../src/modules/strategies/composition.js'

it('creates and recovers through HTTP, application and MySQL adapter with one transaction and one immutable result', async () => {
  let receipt: Record<string, unknown> | undefined
  let failAck = true, failRead = false
  const writes: string[] = []
  const pool = { execute: vi.fn(async () => { throw Error('pool read outside transaction') }), getConnection: vi.fn(async () => {
    let pending: Record<string, unknown> | undefined
    let strategy: Record<string, unknown> | undefined, version: Record<string, unknown> | undefined
    return { beginTransaction: async () => {}, release: () => {}, destroy: () => {},
      commit: async () => { receipt = pending ?? receipt; if (failAck) { failAck = false; throw Error('private ack failure') } },
      rollback: async () => {},
      execute: async (sql: string, args: unknown[]) => {
        if (sql.startsWith('SELECT id FROM users')) return [[{ id: 7 }], []]
        if (sql.startsWith('SELECT action')) return [receipt ? [receipt] : [], []]
        if (sql.startsWith('INSERT INTO strategies')) {
          writes.push('strategy')
          strategy = { id: '17', kind: args[0], scope: 'user', owner_user_id: args[1], name: args[2], description: args[3], status: 'draft', active_version_id: null, revision: 1 }
          return [{ insertId: 17 }, []]
        }
        if (sql.startsWith('INSERT INTO strategy_versions')) {
          writes.push('version')
          version = { id: '18', strategy_id: '17', kind: strategy!.kind, version_number: 1, prompt_text: args[1], prompt_sha256: args[2],
            input_contract_version: args[3], output_contract_version: args[4], config_json: args[5], created_by_user_id: args[6], created_at_utc: new Date('2026-09-09T00:00:00.000Z') }
          return [{ insertId: 18 }, []]
        }
        if (sql.startsWith('SELECT CAST(s.id')) { if (failRead) throw Error('read failure'); return [[strategy], []] }
        if (sql.startsWith('SELECT CAST(v.id')) return [[version], []]
        if (sql.startsWith('INSERT INTO strategy_write_receipts_v4')) {
          writes.push('receipt')
          pending = { action: args[2], request_sha256: args[3], resource_id: args[4], result_revision: String(args[5]), result_json: args[6], result_sha256: args[7] }
          return [{ affectedRows: 1 }, []]
        }
        throw Error('unexpected SQL')
      },
    }
  }) }
  const app = Fastify()
  await app.register(createStrategyHttp(createMysqlStrategyService(pool as unknown as Pool), {
    authenticate: async () => ({ userId: 7 }), assertWrite: async () => ({ userId: 7 }),
  }))
  const request = { method: 'POST' as const, url: '/api/v4/strategies', headers: {
    'x-csrf-token': 'csrf-token-123456789', 'idempotency-key': 'strategy-create-001',
  }, payload: { kind: 'analysis', name: ' original ', description: '', prompt_text: ' analyse ', config: {} } }
  try {
    const invalid = await app.inject({ ...request, payload: { ...request.payload, actor_user_id: '8' } })
    expect(invalid.statusCode).toBe(400)
    expect(pool.getConnection).not.toHaveBeenCalled()
    const unknown = await app.inject(request)
    expect(unknown.statusCode).toBe(503)
    expect(unknown.json()).toMatchObject({ code: 'strategy_commit_unknown', retryable: false })
    expect(unknown.body).not.toContain('private')
    const replay = await app.inject(request)
    expect(replay.statusCode).toBe(201)
    expect(replay.headers.etag).toBe('"1"')
    expect(replay.headers['cache-control']).toBe('no-store')
    expect(replay.json().data).toMatchObject({ id: '17', name: 'original', revision: '1', versions: [{ prompt_text: 'analyse' }] })
    expect(writes).toEqual(['strategy', 'version', 'receipt'])
    expect(pool.execute).not.toHaveBeenCalled()
    // Whitespace is part of submitted content even when persistence normalizes it.
    const conflict = await app.inject({ ...request, payload: { ...request.payload, name: 'original' } })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json().code).toBe('strategy_idempotency_conflict')
    expect(writes).toHaveLength(3)
    receipt = undefined; failRead = true
    const failedRead = await app.inject(request)
    expect(failedRead.statusCode).toBe(503)
    expect(failedRead.json().code).toBe('strategy_unavailable')
    expect(receipt).toBeUndefined()
  } finally { await app.close() }
})
