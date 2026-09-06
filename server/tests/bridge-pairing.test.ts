import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { Pool } from 'mysql2/promise'
import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { BridgePairingService, BridgePairingError } from '../src/modules/bridge/application/bridge-pairing-service.js'
import { MysqlBridgePairingRepository } from '../src/modules/bridge/infrastructure/mysql-bridge-pairing-repository.js'
import { bridgePairingRoutes } from '../src/modules/bridge/transport/http/bridge-pairing-routes.js'
import { MysqlBridgeDeviceRevoker } from '../src/modules/auth/infrastructure/mysql-bridge-device-revoker.js'
import { AuthError } from '../src/modules/auth/domain/auth.js'

const code = `bpc_${'a'.repeat(43)}`
const token = `br4_${'b'.repeat(64)}`
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const pair = { id: '11111111-1111-4111-8111-111111111111', user_id: 7, code_hash: hash(code),
  profile_id: 'profile-11111111-1111-4111-8111-111111111111', installation_id: null, refresh_session_id: null,
  consumed_at_utc: null, revoked_at_utc: null, expires_at: '2026-09-06T00:10:00.000Z', unexpired: 1 }

function database(results: unknown[]) {
  const execute = vi.fn(async (..._args: unknown[]) => {
    if (!results.length) throw new Error('unexpected_query')
    const result = results.shift()
    if (result instanceof Error) throw result
    return [result, []]
  })
  const connection = { execute, beginTransaction: vi.fn(async () => {}), commit: vi.fn(async () => {}),
    rollback: vi.fn(async () => {}), release: vi.fn() }
  const lookup = vi.fn(async () => [[{ user_id: 7 }], []])
  const pool = { execute: lookup, getConnection: async () => connection } as unknown as Pool
  return { pool, connection, execute, lookup, repository: new MysqlBridgePairingRepository(pool) }
}

describe('V4 pairing persistence (SQL double, not real MySQL)', () => {
  it('creates a code receipt under the user lock without a plaintext secret or account grant', async () => {
    const f = database([[{ id: 7 }], [], [{ count: 0 }], { affectedRows: 1 }, [pair]])
    await expect(f.repository.create(7, 'request-0001', hash(code))).resolves.toMatchObject({ profileId: pair.profile_id })
    expect(f.connection.commit).toHaveBeenCalledOnce()
    const statements = f.execute.mock.calls.map(call => String(call[0]))
    expect(statements[0]).toMatch(/FROM users.*id=\?[\s\S]*FOR UPDATE/)
    expect(statements.join('\n')).not.toMatch(/INSERT INTO (trading_accounts|account_ownership)/)
    expect(JSON.stringify(f.execute.mock.calls)).not.toContain(code)
    expect(f.execute.mock.calls[3]![1]).toEqual([expect.any(String), 7, 'request-0001', hash(code), expect.stringMatching(/^profile-/)])
  })
  it('reuses an identical request without creating a second profile', async () => {
    const f = database([[{ id: 7 }], [pair]])
    await expect(f.repository.create(7, 'request-0001', hash(code))).resolves.toMatchObject({ pairingId: pair.id })
    expect(f.execute).toHaveBeenCalledTimes(2)
  })
  it('rejects conflicting idempotency bodies', async () => {
    const f = database([[{ id: 7 }], [pair]])
    await expect(f.repository.create(7, 'request-0001', 'c'.repeat(64))).rejects.toMatchObject({ status: 409 })
    expect(f.connection.rollback).toHaveBeenCalledOnce()
  })
  it('bounds pairing creation without consuming WebSocket quota', async () => {
    const f = database([[{ id: 7 }], [], [{ count: 10 }]])
    await expect(f.repository.create(7, 'request-0001', hash(code))).rejects.toMatchObject({ status: 429 })
    expect(f.execute).toHaveBeenCalledTimes(3)
  })
  it('commits credential creation and code consumption together', async () => {
    const f = database([[{ id: 7 }], [pair], [], [], { insertId: 88 }, { affectedRows: 1 }])
    await expect(f.repository.redeem(hash(code), 'install-1', hash(token))).resolves.toEqual({
      profileId: pair.profile_id, installationId: 'install-1', generation: 1,
    })
    expect(f.execute.mock.calls[4]![1]).toEqual([7, hash(token), 'install-1', pair.profile_id])
    expect(f.execute.mock.calls[5]![1]).toEqual(['install-1', 88, pair.id])
    expect(f.connection.commit).toHaveBeenCalledOnce()
    expect(JSON.stringify(f.execute.mock.calls)).not.toContain(token)
  })
  it('rolls back credential creation when code consumption fails', async () => {
    const f = database([[{ id: 7 }], [pair], [], [], { insertId: 88 }, new Error('sql_secret_detail')])
    await expect(f.repository.redeem(hash(code), 'install-1', hash(token))).rejects.toMatchObject({ code: 'bridge_pairing_storage_failed' })
    expect(f.connection.rollback).toHaveBeenCalledOnce()
    expect(f.connection.commit).not.toHaveBeenCalled()
  })
  it('permits only an identical lost-response retry without credential rotation', async () => {
    const f = database([[{ id: 7 }], [{ ...pair, consumed_at_utc: 'now', installation_id: 'install-1', refresh_session_id: 88 }], [{ generation: 1 }]])
    await expect(f.repository.redeem(hash(code), 'install-1', hash(token))).resolves.toMatchObject({ generation: 1 })
    expect(f.execute.mock.calls[2]![1]).toEqual([88, 7, 'install-1', pair.profile_id, hash(token)])
    expect(String(f.execute.mock.calls[2]![0])).toContain('revoked_at IS NULL')
    expect(f.execute).toHaveBeenCalledTimes(3)
  })
  it.each(['install-2', 'install-1'])('refuses a consumed code with changed installation/token or revoked credential: %s', async installation => {
    const f = database([[{ id: 7 }], [{ ...pair, consumed_at_utc: 'now', installation_id: 'install-1', refresh_session_id: 88 }], []])
    await expect(f.repository.redeem(hash(code), installation, 'c'.repeat(64))).rejects.toMatchObject({ code: 'bridge_pairing_already_used' })
    expect(f.connection.commit).not.toHaveBeenCalled()
  })
  it.each([
    [{ ...pair, unexpired: 0 }, 'bridge_pairing_expired'],
    [{ ...pair, revoked_at_utc: 'now' }, 'bridge_pairing_revoked'],
  ] as const)('rejects invalidated codes before credential writes', async (row, expected) => {
    const f = database([[{ id: 7 }], [row]])
    await expect(f.repository.redeem(hash(code), 'install-1', hash(token))).rejects.toMatchObject({ code: expected })
    expect(f.execute).toHaveBeenCalledTimes(2)
  })
  it('rechecks user eligibility at redemption', async () => {
    const f = database([[]])
    await expect(f.repository.redeem(hash(code), 'install-1', hash(token))).rejects.toMatchObject({ status: 403 })
    expect(String(f.execute.mock.calls[0]![0])).toContain("plan='pro'")
    expect(String(f.execute.mock.calls[0]![0])).toContain("role='admin'")
  })
  it('rejects an existing profile instead of taking it over', async () => {
    const f = database([[{ id: 7 }], [pair], [{ id: pair.profile_id }], []])
    await expect(f.repository.redeem(hash(code), 'install-1', hash(token))).rejects.toMatchObject({ code: 'bridge_pairing_profile_conflict' })
  })
  it('revokes pending codes and credentials in one user-locked transaction', async () => {
    const f = database([[{ id: 7 }], { affectedRows: 1 }, { affectedRows: 1 }])
    await new MysqlBridgeDeviceRevoker(f.pool).revokeUserDevices(7, 'revoke_all_devices', new Date())
    expect(String(f.execute.mock.calls[0]![0])).toContain('FOR UPDATE')
    expect(String(f.execute.mock.calls[1]![0])).toContain('UPDATE bridge_v4_pairing_requests')
    expect(String(f.execute.mock.calls[2]![0])).toContain('UPDATE bridge_refresh_sessions')
    expect(f.connection.commit).toHaveBeenCalledOnce()
  })
})

describe('V4 pairing HTTP and machine contract', () => {
  async function fixture() {
    const repository = { create: vi.fn(async () => ({ pairingId: pair.id, profileId: pair.profile_id, expiresAt: pair.expires_at })),
      redeem: vi.fn(async () => ({ profileId: pair.profile_id, installationId: 'install-1', generation: 1 })) }
    const auth = { assertWrite: vi.fn(async () => ({ userId: 7 })) }
    const app = Fastify()
    await app.register(bridgePairingRoutes, { service: new BridgePairingService(repository), auth, prefix: '/api/v4' })
    return { app, repository, auth }
  }
  it('requires trade write auth, hashes machine secrets and never echoes them', async () => {
    const f = await fixture()
    try {
      const created = await f.app.inject({ method: 'POST', url: '/api/v4/bridge/pairing-requests', headers: { 'idempotency-key': 'request-00000001-0001' }, payload: { code_hash: hash(code) } })
      expect(created.statusCode).toBe(201)
      expect(f.auth.assertWrite).toHaveBeenCalledOnce()
      expect(f.repository.create).toHaveBeenCalledWith(7, 'request-00000001-0001', hash(code))
      const redeemed = await f.app.inject({ method: 'POST', url: '/api/v4/bridge/pairing-redemptions', payload: { pairing_code: code, installation_id: 'install-1', refresh_token: token } })
      expect(redeemed.statusCode).toBe(201)
      expect(redeemed.headers['cache-control']).toBe('no-store')
      expect(redeemed.body).not.toContain(token)
      expect(redeemed.body).not.toContain(code)
      expect(f.repository.redeem).toHaveBeenCalledWith(hash(code), 'install-1', hash(token))
      const spec = JSON.parse(readFileSync(new URL('../../contracts/openapi-v4.json', import.meta.url), 'utf8'))
      expect(Object.keys(redeemed.json().data).sort()).toEqual([...spec.components.schemas.BridgePairingCredentialResponse.properties.data.required].sort())
      expect(spec.paths['/bridge/pairing-redemptions'].post.security).toEqual([])
      expect(spec.paths['/bridge/pairing-requests'].post.parameters).toContainEqual({ $ref: '#/components/parameters/CsrfToken' })
    } finally { await f.app.close() }
  })
  it('does not create a request when CSRF/session validation fails', async () => {
    const f = await fixture()
    try {
      f.auth.assertWrite.mockRejectedValue(new AuthError('auth_csrf_invalid', 403))
      const response = await f.app.inject({ method: 'POST', url: '/api/v4/bridge/pairing-requests', payload: { code_hash: hash(code) } })
      expect(response.statusCode).toBe(403)
      expect(f.repository.create).not.toHaveBeenCalled()
    } finally { await f.app.close() }
  })
  it('rejects malformed requests and missing idempotency key before persistence', async () => {
    const f = await fixture()
    try {
      for (const payload of [{ code_hash: hash(code) }, { code_hash: hash(code), user_id: 8 }]) {
        expect((await f.app.inject({ method: 'POST', url: '/api/v4/bridge/pairing-requests', payload })).statusCode).toBe(400)
      }
      expect((await f.app.inject({ method: 'POST', url: '/api/v4/bridge/pairing-redemptions', headers: { 'content-type': 'application/json' }, payload: '{broken' })).statusCode).toBe(400)
      for (const payload of [
        { pairing_code: code + '\n', installation_id: 'install-1', refresh_token: token },
        { pairing_code: code, installation_id: 'install-1', refresh_token: token + '\n' },
      ]) {
        expect((await f.app.inject({ method: 'POST', url: '/api/v4/bridge/pairing-redemptions', payload })).statusCode).toBe(400)
      }
      expect(f.repository.create).not.toHaveBeenCalled()
      expect(f.repository.redeem).not.toHaveBeenCalled()
    } finally { await f.app.close() }
  })
  it('keeps domain errors stable and redacts storage details', async () => {
    const f = await fixture()
    try {
      for (const error of [new BridgePairingError('bridge_pairing_expired', 410), new Error(`sql ${token}`)]) {
        f.repository.redeem.mockRejectedValueOnce(error)
        const response = await f.app.inject({ method: 'POST', url: '/api/v4/bridge/pairing-redemptions', payload: { pairing_code: code, installation_id: 'install-1', refresh_token: token } })
        expect(response.statusCode).toBe(error instanceof BridgePairingError ? 410 : 503)
        expect(response.body).not.toContain(token)
      }
    } finally { await f.app.close() }
  })
})
