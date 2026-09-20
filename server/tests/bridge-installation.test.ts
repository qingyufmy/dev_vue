import { createHash } from 'node:crypto'
import type { Pool } from 'mysql2/promise'
import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { BridgeInstallationService, type BridgeInstallationRepository } from '../src/modules/bridge/application/bridge-installation-service.js'
import { BridgeInstallationError } from '../src/modules/bridge/domain/bridge-installation.js'
import { MysqlBridgeInstallationRepository } from '../src/modules/bridge/infrastructure/mysql-bridge-installation-repository.js'
import { bridgeInstallationRoutes } from '../src/modules/bridge/transport/http/bridge-installation-routes.js'
import { AuthError } from '../src/modules/auth/index.js'

const id = '11111111-1111-4111-8111-111111111111'
const pollSecret = `bip_${'a'.repeat(43)}`, installationToken = `bi4_${'b'.repeat(64)}`, refreshToken = `br4_${'c'.repeat(64)}`
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const start = { installation_id: 'install-1', device_name: '客户电脑', poll_secret_hash: hash(pollSecret), installation_token_hash: hash(installationToken), request_key: 'request-00000001' }
const confirmation = { authorization_id: id, installation_id: 'install-1', device_name: '客户电脑', status: 'pending', revision: '0',
  created_at: '2026-09-14T00:00:00.000Z', expires_at: '2026-09-14T00:10:00.000Z', current_user: { id: '7', display_name: '客户' } }
const identity = { id, installation_id: 'install-1', user: { id: '7', display_name: '客户' }, generation: 1, authorized: true as const }

async function http() {
  const repository = { start: vi.fn().mockResolvedValue({ authorization_id: id, confirmation_path: `/bridge/authorize?request=${id}`, expires_at: confirmation.expires_at, poll_interval_seconds: 5 }),
    confirmation: vi.fn().mockResolvedValue(confirmation), decide: vi.fn().mockResolvedValue({ ...confirmation, status: 'approved', revision: '1' }),
    poll: vi.fn().mockResolvedValue({ status: 'pending', poll_interval_seconds: 5 }), authenticate: vi.fn().mockResolvedValue(identity),
    registerProfile: vi.fn().mockResolvedValue({ profile_id: 'profile-1', generation: 1 }), revoke: vi.fn().mockResolvedValue(undefined) }
  const capacity = { summary: vi.fn().mockResolvedValue({ included: 1, purchased: 1, total: 2, active: 1, available: 1 }) }
  const app = Fastify()
  const auth = { authenticate: vi.fn().mockResolvedValue({ userId: 7 }), assertWrite: vi.fn(async (req: { headers: Record<string, unknown> }) => {
    if (req.headers['x-csrf-token'] !== 'csrf-test-00000001') throw new AuthError('auth_csrf_invalid', 403)
    return { userId: 7 }
  }) }
  await app.register(bridgeInstallationRoutes, { prefix: '/api/v4', service: new BridgeInstallationService(repository as BridgeInstallationRepository, capacity), auth })
  return { app, repository, auth, capacity }
}

describe('installation HTTP contract and boundaries', () => {
  it('starts with hashes only and rejects Origin, malformed hashes and extra fields', async () => {
    const f = await http()
    try {
      const req = { method: 'POST' as const, url: '/api/v4/bridge/installation-authorizations', payload: start }
      expect((await f.app.inject(req)).statusCode).toBe(200)
      expect(f.repository.start).toHaveBeenCalledWith(start, expect.stringMatching(/^[a-f0-9]{64}$/))
      for (const mutation of [{ headers: { origin: 'https://evil.test' } }, { payload: { ...start, poll_secret_hash: 'bad' } }, { payload: { ...start, user_id: 7 } }]) {
        expect((await f.app.inject({ ...req, ...mutation })).statusCode).toBe(mutation.headers ? 403 : 400)
      }
      expect(f.repository.start).toHaveBeenCalledOnce()
    } finally { await f.app.close() }
  })
  it('requires browser CSRF, stable idempotency and matching displayed account', async () => {
    const f = await http()
    try {
      const req = { method: 'POST' as const, url: `/api/v4/bridge/installation-authorizations/${id}/decision`, payload: { decision: 'approved', expected_revision: '0', current_user_id: '7' } }
      expect((await f.app.inject(req)).statusCode).toBe(403)
      const headers = { 'x-csrf-token': 'csrf-test-00000001', 'idempotency-key': 'decision-00000001' }
      expect((await f.app.inject({ ...req, headers, payload: { ...req.payload, current_user_id: '8' } })).statusCode).toBe(409)
      expect((await f.app.inject({ ...req, headers })).statusCode).toBe(200)
      expect(f.repository.decide).toHaveBeenCalledExactlyOnceWith(id, 7, 'decision-00000001', 'approved', '0')
    } finally { await f.app.close() }
  })
  it('polls only with private proof, hashes before persistence and propagates slow polling', async () => {
    const f = await http()
    try {
      const req = { method: 'POST' as const, url: `/api/v4/bridge/installation-authorizations/${id}/poll`, payload: { poll_secret: pollSecret, installation_token: installationToken } }
      expect((await f.app.inject(req)).json()).toMatchObject({ data: { status: 'pending' } })
      expect(f.repository.poll).toHaveBeenCalledWith(id, hash(pollSecret), hash(installationToken))
      f.repository.poll.mockRejectedValueOnce(new BridgeInstallationError('bridge_installation_slow_down', 429, 5))
      const response = await f.app.inject(req)
      expect(response.statusCode).toBe(429); expect(response.headers['retry-after']).toBe('5')
      expect(response.body).not.toContain(pollSecret)
    } finally { await f.app.close() }
  })
  it('uses authoritative capacity and keeps child credentials independent', async () => {
    const f = await http()
    try {
      const proof = { installation_id: 'install-1', installation_token: installationToken }
      const response = await f.app.inject({ method: 'POST', url: '/api/v4/bridge/installations/status', payload: proof })
      expect(response.statusCode).toBe(200); expect(response.json().data.capacity.active).toBe(1)
      expect(f.capacity.summary).toHaveBeenCalledWith(7)
      const profile = await f.app.inject({ method: 'POST', url: '/api/v4/bridge/installations/profiles', payload: { ...proof, request_key: 'profile-request-001', refresh_token: refreshToken } })
      expect(profile.statusCode).toBe(200)
      expect(f.repository.registerProfile).toHaveBeenCalledWith('install-1', hash(installationToken), 'profile-request-001', hash(refreshToken))
      expect(profile.body).not.toContain(refreshToken)
      f.capacity.summary.mockRejectedValueOnce(Error('redis unreachable'))
      const failed = await f.app.inject({ method: 'POST', url: '/api/v4/bridge/installations/status', payload: proof })
      expect(failed.statusCode).toBe(503); expect(failed.json()).not.toHaveProperty('data.capacity')
    } finally { await f.app.close() }
  })
})

const row = { id, ...start, status: 'pending', revision: 0, user_id: null, decision_key: null, created_at: confirmation.created_at, expires_at: confirmation.expires_at, unexpired: 1, may_poll: 1 }
function database(results: unknown[], lookup: unknown[] = []) {
  const execute = vi.fn(async (..._args: unknown[]) => { if (!results.length) throw Error('unexpected SQL'); const result = results.shift(); if (result instanceof Error) throw result; return [result, []] })
  const c = { execute, beginTransaction: vi.fn(async () => {}), commit: vi.fn(async () => {}), rollback: vi.fn(async () => {}), release: vi.fn(), destroy: vi.fn() }
  const pool = { getConnection: async () => c, execute: vi.fn(async () => [lookup, []]) } as unknown as Pool
  return { repository: new MysqlBridgeInstallationRepository(pool), c, execute }
}
describe('installation transactional persistence (SQL doubles, no DB)', () => {
  it('replays creation only for identical private bindings', async () => {
    const f = database([{}, [{ request_count: 0, recent: 1 }], [row]])
    expect((await f.repository.start(start, hash('ip'))).authorization_id).toBe(id)
    const conflict = database([{}, [{ request_count: 0, recent: 1 }], [{ ...row, installation_token_hash: 'different' }]])
    await expect(conflict.repository.start(start, hash('ip'))).rejects.toMatchObject({ status: 409 })
  })
  it('rate limits request creation within a locked persistent IP bucket', async () => {
    const f = database([{}, [{ request_count: 10, recent: 1 }], []])
    await expect(f.repository.start(start, hash('ip'))).rejects.toMatchObject({ status: 429 })
    expect(String(f.execute.mock.calls[1]?.[0])).toContain('FOR UPDATE')
  })
  it('approves atomically for one user and records the decision', async () => {
    const f = database([[{ id: 7 }], [row], [], {}, {}, [{ id: 7, nickname: '客户' }]])
    expect((await f.repository.decide(id, 7, 'decision-key-0001', 'approved', '0')).status).toBe('approved')
    expect(f.c.commit).toHaveBeenCalledOnce()
    expect(JSON.stringify(f.execute.mock.calls)).not.toContain(installationToken)
  })
  it('rejects expired approval and cross-account decision replays', async () => {
    const expired = database([[{ id: 7 }], [{ ...row, unexpired: 0 }]])
    await expect(expired.repository.decide(id, 7, 'decision-key-0001', 'approved', '0')).rejects.toMatchObject({ status: 410 })
    const crossed = database([[{ id: 8 }], [{ ...row, status: 'approved', user_id: 7, decision_key: 'decision-key-0001', revision: 1 }]])
    await expect(crossed.repository.decide(id, 8, 'decision-key-0001', 'approved', '0')).rejects.toMatchObject({ status: 409 })
  })
  it('rejects premature polling and expires only pending requests', async () => {
    const early = database([[{ ...row, may_poll: 0 }]])
    await expect(early.repository.poll(id, hash(pollSecret), hash(installationToken))).rejects.toMatchObject({ status: 429, retryAfterSeconds: 5 })
    const expired = database([[{ ...row, unexpired: 0, status: 'pending' }], {}])
    expect(await expired.repository.poll(id, hash(pollSecret), hash(installationToken))).toEqual({ status: 'expired', poll_interval_seconds: 5 })
  })
  it('recovers an approved installation after restart beyond the ten-minute approval deadline', async () => {
    const f = database([[{ ...row, unexpired: 0, status: 'approved', user_id: 7 }], {},
      [{ id, user_id: 7, installation_id: 'install-1', nickname: '客户', generation: 1, revoked_at_utc: null }]])
    expect(await f.repository.poll(id, hash(pollSecret), hash(installationToken))).toEqual({ status: 'approved', poll_interval_seconds: 5,
      installation_id: 'install-1', user: { id: '7', display_name: '客户' }, generation: 1, authorized: true })
    expect(f.execute.mock.calls[0]?.[1]).toEqual([id, hash(pollSecret), hash(installationToken)])
    expect(String(f.execute.mock.calls[2]?.[0])).toContain('i.revoked_at_utc IS NULL')
  })
  it('retains revoked decisions beyond the approval deadline', async () => {
    const f = database([[{ ...row, unexpired: 0, status: 'revoked', user_id: 7 }], {}])
    expect(await f.repository.poll(id, hash(pollSecret), hash(installationToken))).toEqual({ status: 'revoked', poll_interval_seconds: 5 })
    expect(f.execute).toHaveBeenCalledTimes(2)
  })
  it('does not recover an approved installation with invalid private proof or revoked installation authority', async () => {
    const invalid = database([[]])
    await expect(invalid.repository.poll(id, hash('wrong'), hash(installationToken))).rejects.toMatchObject({ code: 'bridge_installation_poll_invalid', status: 401 })
    const revoked = database([[{ ...row, unexpired: 0, status: 'approved', user_id: 7 }], {}, []])
    await expect(revoked.repository.poll(id, hash(pollSecret), hash(installationToken))).rejects.toMatchObject({ code: 'bridge_installation_credential_invalid', status: 401 })
  })
  it('revokes installation and every child atomically and is replayable', async () => {
    const f = database([[{ id: 7 }], [{ id }], {}, {}, {}], [{ user_id: 7 }])
    await f.repository.revoke('install-1', hash(installationToken))
    expect(String(f.execute.mock.calls[4]?.[0])).toContain('WHERE installation_authorization_id=?')
    expect(f.c.commit).toHaveBeenCalledOnce()
  })
  it('does not return a success after lost commit acknowledgement', async () => {
    const f = database([{}, [{ request_count: 0, recent: 1 }], [row]])
    f.c.commit.mockRejectedValueOnce(Error('lost ack'))
    await expect(f.repository.start(start, hash('ip'))).rejects.toMatchObject({ code: 'bridge_installation_commit_unknown' })
    expect(f.c.destroy).toHaveBeenCalledOnce(); expect(f.c.rollback).not.toHaveBeenCalled()
  })
})
