import Fastify from 'fastify'
import { createHash } from 'node:crypto'
import type { Pool } from 'mysql2/promise'
import { expect, it } from 'vitest'
import { strategyRoutes } from '../src/modules/strategies/transport/http/strategy-routes.js'
import { compileStrategy } from '../src/modules/strategies/application/strategy-service.js'
import { platformStrategyRoutes } from '../src/modules/strategies/transport/http/platform-strategy-routes.js'
import type { StrategyService } from '../src/modules/strategies/application/strategy-service.js'
import { createPlatformStrategyPublisher } from '../src/modules/strategies/infrastructure/mysql-platform-strategy-publisher.js'
import { createMysqlStrategyService, createPlatformStrategyHttp } from '../src/modules/strategies/composition.js'

it('requires admin authorization, validates revision, publishes once and replays the receipt', async () => {
  let admin = false, updates = 0, receipt: Record<string, unknown> | undefined
  const row = { id: '1', scope: 'platform', owner_user_id: null, kind: 'analysis', name: '道诚', description: '', revision: 1, status: 'draft', active_version_id: null as string | null }
  const version = { id: '1', strategy_id: '1', kind: 'analysis', version_number: 44, prompt_text: 'analyse', prompt_sha256: createHash('sha256').update('analyse').digest('hex'), config_json: {}, input_contract_version: 'market-analysis-input/v1', output_contract_version: 'market-analysis/v1', created_by_user_id: 1, created_at_utc: new Date('2026-09-14T00:00:00Z') }
  const connection = { beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {}, destroy: () => {}, execute: async (sql: string, args: unknown[]) => {
    if (sql.startsWith('SELECT id FROM users') || sql.startsWith('SELECT id FROM strategies')) return [[{ id: 1 }], []]
    if (sql.startsWith('SELECT CAST(s.id')) return [[row], []]
    if (sql.startsWith('SELECT CAST(v.id')) return [[version], []]
    if (sql.startsWith('SELECT action')) return [receipt ? [receipt] : [], []]
    if (sql.startsWith('UPDATE strategies')) { updates++; row.revision++; row.status = 'active'; row.active_version_id = '1'; return [{ affectedRows: 1 }, []] }
    if (sql.startsWith('INSERT INTO strategy_write_receipts')) { receipt = { action: args[2], request_sha256: args[3], resource_id: args[4], result_revision: String(args[5]), result_json: args[6], result_sha256: args[7] }; return [{ affectedRows: 1 }, []] }
    throw Error('Unexpected query')
  } }
  const pool = { getConnection: async () => connection } as unknown as Pool
  const app = Fastify(), auth = { authenticate: async () => ({ userId: 1, role: admin ? 'admin' : 'user' }), assertWrite: async () => ({ userId: 1, role: admin ? 'admin' : 'user' }) }
  await app.register(createPlatformStrategyHttp(pool, createMysqlStrategyService(pool), auth, () => ({ isAdmin: async () => admin })))
  const request = { method: 'POST' as const, url: '/api/v4/admin/strategies/1/versions/1/publish', headers: { 'x-csrf-token': 'csrf-token-123456789', 'idempotency-key': 'publish-platform-001', 'if-match': '"1"' } }
  try {
    expect((await app.inject(request)).statusCode).toBe(403)
    admin = true
    expect((await app.inject({ ...request, headers: { ...request.headers, 'if-match': '"2"' } })).statusCode).toBe(412)
    version.prompt_sha256 = '0'.repeat(64)
    expect((await app.inject(request)).statusCode).toBe(422)
    expect(updates).toBe(0)
    version.prompt_sha256 = createHash('sha256').update('analyse').digest('hex')
    const result = await app.inject(request)
    expect(result.statusCode, result.body).toBe(200)
    expect((await app.inject(request)).statusCode).toBe(200)
    expect(updates).toBe(1)
    admin = false
    expect((await app.inject(request)).statusCode).toBe(403)
  } finally { await app.close() }
})

it.each([undefined, 'active', 'draft'] as const)('saves a platform edit with status %s atomically and rechecks admin on replay', async status => {
  let admin = false, receipt: Record<string, unknown> | undefined, inserts = 0
  const row = { id: '1', scope: 'platform', owner_user_id: null, kind: 'analysis', name: 'Test', description: '', revision: 1, status: 'active', active_version_id: '1' }
  const versions = [{ id: '1', strategy_id: '1', kind: 'analysis', version_number: 1, prompt_text: 'original', prompt_sha256: '', config_json: {}, input_contract_version: 'market-analysis-input/v1', output_contract_version: 'market-analysis/v1', created_by_user_id: 1, created_at_utc: new Date() }]
  const connection = { beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {}, destroy: () => {}, execute: async (sql: string, args: unknown[]) => {
    if (sql.startsWith('SELECT id FROM')) return [[{ id: 1 }], []]
    if (sql.startsWith('SELECT CAST(s.id')) return [[row], []]
    if (sql.startsWith('SELECT CAST(v.id')) return [versions, []]
    if (sql.startsWith('SELECT action')) return [receipt ? [receipt] : [], []]
    if (sql.startsWith('INSERT INTO strategy_versions')) { inserts++; versions.push({ ...versions[0]!, id: '2', version_number: Number(args[1]), prompt_text: String(args[2]), prompt_sha256: String(args[3]), config_json: JSON.parse(String(args[6])) }); return [{ affectedRows: 1, insertId: 2 }, []] }
    if (sql.startsWith('UPDATE strategies')) { row.revision++; if (status) { expect(args.slice(0, 5)).toEqual(['修改名称', '修改说明', status, status, 2]); row.name = String(args[0]); row.description = String(args[1]); row.status = status; if (status === 'active') row.active_version_id = '2' } return [{ affectedRows: 1 }, []] }
    if (sql.startsWith('INSERT INTO strategy_write_receipts')) { receipt = { action: args[2], request_sha256: args[3], resource_id: args[4], result_revision: String(args[5]), result_json: args[6], result_sha256: args[7] }; return [{ affectedRows: 1 }, []] }
    throw Error('Unexpected query: ' + sql)
  } }
  const publisher = createPlatformStrategyPublisher({ getConnection: async () => connection } as unknown as Pool, () => ({ isAdmin: async () => admin }))
  const input = { userId: 1, strategyId: '1', expectedRevision: 1, idempotencyKey: 'platform-edit-test-001', promptText: 'updated prompt', config: {}, ...(status ? { name: '修改名称', description: '修改说明', status } : {}) }
  await expect(publisher.createVersion(input)).rejects.toMatchObject({ status: 403 })
  admin = true
  await expect(publisher.createVersion({ ...input, expectedRevision: 2 })).rejects.toMatchObject({ status: 412 })
  await expect(publisher.createVersion({ ...input, promptText: '' })).rejects.toMatchObject({ status: 422 })
  expect(inserts).toBe(0)
  const saved = await publisher.createVersion(input)
  expect(saved.summary.activeVersionId).toBe(status === 'active' ? '2' : '1')
  expect(saved.summary.status).toBe(status ?? 'active')
  if (status) expect(saved.summary).toMatchObject({ name: '修改名称', description: '修改说明' })
  expect(saved.versions).toHaveLength(2)
  expect(await publisher.createVersion(input)).toEqual(saved)
  expect(inserts).toBe(1)
  admin = false
  await expect(publisher.createVersion(input)).rejects.toMatchObject({ status: 403 })
})

it('validates the administrator create-version HTTP contract and returns 201', async () => {
  const app = Fastify()
  let calls = 0
  await app.register(platformStrategyRoutes, { service: {} as StrategyService, auth: { authenticate: async () => ({ userId: 1, role: 'admin' }), assertWrite: async () => ({ userId: 1, role: 'admin' }) }, publisher: {
    publish: async () => { throw Error('unexpected') },
    createVersion: async input => { calls++; expect(input.promptText).toBe('updated prompt'); return { summary: { id: '1', kind: 'analysis', scope: 'platform', ownerUserId: null, name: 'Test', description: '', status: 'draft', activeVersionId: null, revision: 2 }, versions: [] } },
  } })
  const request = { method: 'POST' as const, url: '/admin/strategies/1/versions', headers: { 'x-csrf-token': 'csrf-token-123456789', 'idempotency-key': 'platform-edit-http-001', 'if-match': '"1"' }, payload: { prompt_text: 'updated prompt', config: {} } }
  try {
    expect((await app.inject({ ...request, payload: { ...request.payload, unexpected: true } })).statusCode).toBe(400)
    const result = await app.inject(request)
    expect(result.statusCode, result.body).toBe(201)
    expect(calls).toBe(1)
  } finally { await app.close() }
})

it('edits a platform version through the trade surface with server-side admin checks', async () => {
  const app = Fastify()
  let admin = false, saved = 0
  const detail = { summary: { id: '1', kind: 'analysis' as const, scope: 'platform' as const, ownerUserId: null, name: 'Test', description: '', status: 'draft' as const, activeVersionId: null, revision: 2 }, versions: [] }
  await app.register(strategyRoutes, { service: { detail: async () => detail } as unknown as StrategyService,
    auth: { authenticate: async () => ({ userId: 1 }), assertWrite: async () => ({ userId: 1 }) },
    platformPublisher: { publish: async () => detail, createVersion: async () => { if (!admin) throw Object.assign(new (await import('../src/modules/strategies/domain/strategy.js')).StrategyAccessError('strategy_admin_required', 403)); saved++; return detail } },
  })
  const request = { method: 'POST' as const, url: '/strategies/1/versions', headers: { 'x-csrf-token': 'csrf-token-123456789', 'idempotency-key': 'platform-inline-edit-001', 'if-match': '"1"' }, payload: { prompt_text: 'updated prompt', config: {} } }
  try { expect((await app.inject(request)).statusCode).toBe(403); expect(saved).toBe(0); admin = true; const result = await app.inject(request); expect(result.statusCode, result.body).toBe(201); expect(saved).toBe(1) } finally { await app.close() }
})
it('preserves data switches and cadence and rejects EMA outside selected periods', () => {
  const config = { interval_minutes: 10, market_data_plan: { version: 1, primary_timeframe: 'M5', timeframes: [{ timeframe: 'M5', kline_count: 150 }] }, chan_evidence: { version: 1, enabled: false }, ema34_evidence: { version: 1, timeframe: 'M5' } }
  const result = compileStrategy('analysis', 'analyse', config)
  expect(result.valid).toBe(true)
  expect(result.normalizedConfig).toMatchObject(config)
  expect(compileStrategy('analysis', 'analyse', { ...config, interval_minutes: 0 }).valid).toBe(false)
  expect(compileStrategy('analysis', 'analyse', { ...config, ema34_evidence: { version: 1, timeframe: 'M1' } }).valid).toBe(false)
})
