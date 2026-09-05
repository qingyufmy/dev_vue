import Fastify from 'fastify'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  ObserverManagementService,
} from '../src/modules/trading/application/observer-management-service.js'
import {
  type ObserverChannelConfig,
  type ObserverManagementCommand,
  type ObserverManagementList,
  type ObserverManagementPage,
  type ObserverManagementRepository,
  type ObserverManagementResult,
  type ObserverSourceConfig,
} from '../src/modules/trading/application/observer-management-ports.js'
import { observerManagementRoutes } from '../src/modules/trading/transport/http/observer-management-routes.js'
import { AuthObserverAdminAdapter } from '../src/modules/trading/infrastructure/auth-observer-admin-adapter.js'
import type { AuthService } from '../src/modules/auth/application/auth-service.js'

const sourceConfig: ObserverSourceConfig = {
  displayName: '黄金观摩源', notes: null, tradingAccountId: '7', analysisStrategyId: null, status: 'disabled',
}
const channelConfig: ObserverChannelConfig = {
  displayName: '公开频道', sourceId: '1', slug: 'gold-demo', description: null,
  audience: 'assigned', active: false, sortOrder: 0,
}

class MemoryObserverManagementRepository implements ObserverManagementRepository {
  readonly writes: Array<{ actorUserId: number; idempotencyKey: string; requestHash: string; command: ObserverManagementCommand }> = []
  readonly page: ObserverManagementPage = { items: [{ id: '1' }], next_cursor: null, registry_revision: 3 }

  async list(_actorUserId: number, _input: ObserverManagementList) { return this.page }

  async execute(input: { actorUserId: number; idempotencyKey: string; requestHash: string; command: ObserverManagementCommand }): Promise<ObserverManagementResult> {
    this.writes.push(input)
    return { operation_id: '00000000-0000-4000-8000-000000000001', target_id: '1', revision: 1, registry_revision: 4 }
  }
}

function adminAuth(role = 'admin') {
  return {
    async authenticate() { return { userId: 9, role } },
    async assertWrite() { return { userId: 9, role } },
  }
}

function appFor(repository = new MemoryObserverManagementRepository(), role = 'admin') {
  const app = Fastify({ logger: false })
  const service = new ObserverManagementService(repository)
  return { app, repository, service, ready: app.register(observerManagementRoutes, { prefix: '/api/v4/admin/observer', service, auth: adminAuth(role) }) }
}

describe('P4B observer management application boundary', () => {
  it('rejects non-administrators before touching the repository', async () => {
    const repository = new MemoryObserverManagementRepository()
    const service = new ObserverManagementService(repository)
    await expect(service.list(9, 'user', { kind: 'sources', afterId: null, limit: 20 })).rejects.toMatchObject({ code: 'observer_admin_required', status: 403 })
    await expect(service.write(9, 'user', 'valid-key', { kind: 'source.create', config: sourceConfig })).rejects.toMatchObject({ code: 'observer_admin_required', status: 403 })
    expect(repository.writes).toHaveLength(0)
  })

  it('freezes defaults and rejects unsupported activation or unknown fields', async () => {
    const service = new ObserverManagementService(new MemoryObserverManagementRepository())
    await expect(service.write(9, 'admin', 'bad key!', { kind: 'source.create', config: sourceConfig }))
      .rejects.toMatchObject({ code: 'observer_idempotency_key_invalid', status: 400 })
    await expect(service.write(9, 'admin', 'valid-key', {
      kind: 'source.create', config: { ...sourceConfig, status: 'active' },
    })).rejects.toMatchObject({ code: 'observer_source_create_must_start_disabled', status: 422 })
    await expect(service.write(9, 'admin', 'valid-key', {
      kind: 'channel.create', config: { ...channelConfig, active: true },
    })).rejects.toMatchObject({ code: 'observer_channel_create_must_start_inactive', status: 422 })
    await expect(service.write(9, 'admin', 'valid-key', {
      kind: 'source.create', config: { ...sourceConfig, extra: true } as never,
    })).rejects.toMatchObject({ code: 'observer_unknown_field', status: 400 })
  })

  it('uses a stable canonical hash for an idempotent command', async () => {
    const repository = new MemoryObserverManagementRepository()
    const service = new ObserverManagementService(repository)
    const first = await service.write(9, 'admin', 'stable-key', { kind: 'source.create', config: sourceConfig })
    const second = await service.write(9, 'admin', 'stable-key-2', {
      config: { status: 'disabled', analysisStrategyId: null, tradingAccountId: '7', notes: null, displayName: '黄金观摩源' },
      kind: 'source.create',
    })
    expect(first).toEqual(second)
    expect(repository.writes[0]!.requestHash).toBe(repository.writes[1]!.requestHash)
    expect(repository.writes[0]!.requestHash).toMatch(/^[a-f0-9]{64}$/)
    expect(repository.writes[0]!.requestHash).toBe(createHash('sha256').update(JSON.stringify({
      config: { analysisStrategyId: null, displayName: '黄金观摩源', notes: null, status: 'disabled', tradingAccountId: '7' },
      kind: 'source.create',
    })).digest('hex'))
  })

  it('validates bounded list cursors and preserves the page envelope', async () => {
    const { app, ready } = appFor()
    await ready
    const page = await app.inject('/api/v4/admin/observer/sources?limit=20')
    expect(page.statusCode).toBe(200)
    expect(page.json()).toMatchObject({ data: { items: [{ id: '1' }], next_cursor: null, registry_revision: '3' } })
    const badLimit = await app.inject('/api/v4/admin/observer/sources?limit=101')
    expect(badLimit.statusCode).toBe(400)
    const badCursor = await app.inject('/api/v4/admin/observer/operations?cursor=not-a-uuid')
    expect(badCursor.statusCode).toBe(400)
    const unknownQuery = await app.inject('/api/v4/admin/observer/sources?role=admin')
    expect(unknownQuery.statusCode).toBe(400)
    await app.close()
  })

  it('requires idempotency and rejects operator injection while accepting a strict create', async () => {
    const { app, repository, ready } = appFor()
    await ready
    const missingKey = await app.inject({ method: 'POST', url: '/api/v4/admin/observer/sources', payload: { display_name: '源' } })
    expect(missingKey.statusCode).toBe(400)
    const injected = await app.inject({
      method: 'POST', url: '/api/v4/admin/observer/sources', headers: { 'idempotency-key': 'operator-test' },
      payload: { display_name: '源', operator_user_id: 99 },
    })
    expect(injected.statusCode).toBe(400)
    const created = await app.inject({
      method: 'POST', url: '/api/v4/admin/observer/sources', headers: { 'idempotency-key': 'source-create-1' },
      payload: { display_name: '源', trading_account_id: '7' },
    })
    expect(created.statusCode).toBe(201)
    expect(repository.writes[0]!.command).toEqual({ kind: 'source.create', config: { ...sourceConfig, displayName: '源' } })
    expect(created.json()).toMatchObject({ data: { operation_id: expect.any(String), target_id: '1', revision: '1', registry_revision: '4' } })

    const emptyNotes = await app.inject({
      method: 'POST', url: '/api/v4/admin/observer/sources', headers: { 'idempotency-key': 'source-empty-notes' },
      payload: { display_name: '空备注', notes: '' },
    })
    expect(emptyNotes.statusCode).toBe(201)
    expect(repository.writes.at(-1)!.command).toMatchObject({
      kind: 'source.create', config: { displayName: '空备注', notes: '', tradingAccountId: null, analysisStrategyId: null, status: 'disabled' },
    })

    const emptyDescription = await app.inject({
      method: 'POST', url: '/api/v4/admin/observer/channels', headers: { 'idempotency-key': 'channel-empty-description' },
      payload: { display_name: '空描述', slug: 'empty-description', description: '' },
    })
    expect(emptyDescription.statusCode).toBe(201)
    expect(repository.writes.at(-1)!.command).toMatchObject({
      kind: 'channel.create', config: { displayName: '空描述', slug: 'empty-description', description: '', audience: 'assigned', active: false, sortOrder: 0 },
    })
    await app.close()
  })

  it('requires full CAS configuration on updates and handles access/default routes', async () => {
    const { app, repository, ready } = appFor()
    await ready
    const update = await app.inject({
      method: 'PUT', url: '/api/v4/admin/observer/channels/2', headers: { 'idempotency-key': 'channel-update-1' },
      payload: { expected_revision: '1', ...{
        display_name: '频道', source_id: '1', slug: 'channel-2', description: null,
        audience: 'assigned', active: false, sort_order: 2,
      } },
    })
    expect(update.statusCode).toBe(200)
    expect(repository.writes.at(-1)!.command).toMatchObject({ kind: 'channel.update', id: '2', expectedRevision: 1 })
    const access = await app.inject({
      method: 'PUT', url: '/api/v4/admin/observer/channels/2/accesses/42', headers: { 'idempotency-key': 'access-set-1' },
      payload: { granted: true, expected_revision: 0 },
    })
    expect(access.statusCode).toBe(200)
    expect(repository.writes.at(-1)!.command).toMatchObject({ kind: 'access.set', channelId: '2', userId: 42, granted: true, expectedRevision: 0 })
    const cleared = await app.inject({
      method: 'PUT', url: '/api/v4/admin/observer/default-channel', headers: { 'idempotency-key': 'default-clear-1' },
      payload: { channel_id: null, expected_revision: '0' },
    })
    expect(cleared.statusCode).toBe(200)
    expect(repository.writes.at(-1)!.command).toMatchObject({ kind: 'channel.default', channelId: null, expectedRevision: 0 })
    await app.close()
  })

  it('maps the protected canonical command to audit_json and strips receipt secrets', async () => {
    const { app, repository, ready } = appFor()
    repository.page.items = [{
      id: '00000000-0000-4000-8000-000000000002',
      action: 'source.create',
      actor_user_id: 9,
      target_id: '1',
      result: { operation_id: '00000000-0000-4000-8000-000000000002', target_id: '1', revision: 1, registry_revision: 4 },
      audit: { kind: 'source.create', config: { status: 'disabled' } },
      idempotency_key: 'secret-key',
      request_hash: 'secret-hash',
      unexpected: 'must-not-cross-the-boundary',
    }]
    await ready
    const page = await app.inject('/api/v4/admin/observer/operations')
    expect(page.statusCode).toBe(200)
    expect(page.json().data.items[0]).toMatchObject({
      audit_json: { kind: 'source.create', config: { status: 'disabled' } },
      result: { revision: '1', registry_revision: '4' },
    })
    expect(page.json().data.items[0]).not.toHaveProperty('audit')
    expect(page.json().data.items[0]).not.toHaveProperty('idempotency_key')
    expect(page.json().data.items[0]).not.toHaveProperty('request_hash')
    expect(page.json().data.items[0]).not.toHaveProperty('unexpected')
    await app.close()
  })
})

describe('P4B admin session adapter', () => {
  it('only resolves the configured admin-web cookie and never trade-web', async () => {
    const resolveSession = vi.fn(async (raw: string | undefined, client: string) => {
      if (!raw || client !== 'admin-web') throw new Error('not-admin')
      return { session: { id: 1 } as never, user: { id: 7, role: 'admin' } as never }
    })
    const service = {
      cookieName: (client: string) => client === 'admin-web' ? '__Host-Http-admin_session' : '__Host-Http-trade_session',
      resolveSession,
      assertCsrf: vi.fn(),
    } as unknown as AuthService
    const adapter = new AuthObserverAdminAdapter(service)
    await expect(adapter.authenticate({ headers: { cookie: '__Host-Http-trade_session=trade-session' } })).rejects.toThrow('not-admin')
    await expect(adapter.authenticate({ headers: { cookie: 'aurum_dev_admin-web_session=dev-session' } })).rejects.toThrow('not-admin')
    await expect(adapter.authenticate({ headers: { cookie: '__Host-Http-admin_session=admin-session' } })).resolves.toEqual({ userId: 7, role: 'admin' })
    expect(resolveSession).toHaveBeenLastCalledWith('admin-session', 'admin-web')
    await expect(adapter.assertWrite({ headers: {
      cookie: '__Host-Http-admin_session=admin-session',
      'x-csrf-token': 'csrf-token',
      origin: 'https://admin.example.test',
    } })).resolves.toEqual({ userId: 7, role: 'admin' })
    expect(service.assertCsrf).toHaveBeenCalledWith(
      'admin-session', expect.objectContaining({ id: 1 }), 'csrf-token', 'https://admin.example.test',
    )
  })
})
