import { createBridgeCredentialRepository } from '../src/modules/bridge/composition.js'
import type { Pool } from 'mysql2/promise'
import { describe, expect, it, vi } from 'vitest'

import type { RotateLegacyCredentialInput } from '../src/modules/bridge/index.js'

const input: RotateLegacyCredentialInput = {
  legacyTokenHash: 'a'.repeat(64),
  migrationKey: 'b'.repeat(64),
  installationId: 'installation-1',
  profileId: 'default',
  sourceFingerprint: 'sha256:' + 'c'.repeat(64),
  replacementTokenHash: 'd'.repeat(64),
  userAgent: 'smoke',
  ipAddress: '127.0.0.1',
}

function fakePool(results: Array<unknown | Error>) {
  const execute = vi.fn(async (..._args: unknown[]) => {
    const result = results.shift()
    if (result instanceof Error) throw result
    return result
  })
  const connection = {
    beginTransaction: vi.fn(async () => undefined),
    execute,
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    release: vi.fn(),
    destroy: vi.fn(),
  }
  const pool = { getConnection: vi.fn(async () => connection) } as unknown as Pool
  return { pool, connection, execute }
}

describe('MysqlBridgeCredentialRepository', () => {
  it.each(['rotate', 'use', 'revoke'] as const)('reports commit uncertainty without rollback or connection reuse: %s', async operation => {
    const legacy = { session_id: 11, user_id: 7, role: 'user', plan: 'pro', plan_expires_at: null }
    const device = { ...legacy, installation_id: 'installation-1', profile_id: 'default', generation: 1, revoked_at: null }
    const fixture = fakePool(operation === 'rotate'
      ? [[[legacy], []], [[], []], [{ insertId: 22, affectedRows: 1 }, []]]
      : [[[device], []], [{ affectedRows: 1 }, []]])
    fixture.connection.commit.mockRejectedValueOnce(new Error('commit_ack_lost'))
    const repository = createBridgeCredentialRepository(fixture.pool)
    const credential = { tokenHash: input.replacementTokenHash, installationId: input.installationId, profileId: input.profileId,
      userAgent: input.userAgent, ipAddress: input.ipAddress }
    const call = operation === 'rotate' ? repository.rotateFromLegacy(input)
      : operation === 'use' ? repository.useDeviceRefresh(credential) : repository.revokeDeviceRefresh(credential)
    await expect(call).rejects.toMatchObject({ code: 'bridge_credential_commit_unknown', status: 503, retryable: false })
    expect(fixture.connection.commit).toHaveBeenCalledOnce()
    expect(fixture.connection.rollback).not.toHaveBeenCalled()
    expect(fixture.connection.release).not.toHaveBeenCalled()
    expect(fixture.connection.destroy).toHaveBeenCalledOnce()
  })

  it('does not replace an authorization error with a failed rollback error', async () => {
    const fixture = fakePool([[[], []]])
    fixture.connection.rollback.mockRejectedValueOnce(new Error('rollback_failed'))
    await expect(createBridgeCredentialRepository(fixture.pool).rotateFromLegacy(input))
      .rejects.toMatchObject({ code: 'bridge_legacy_credential_invalid', status: 401 })
    expect(fixture.connection.destroy).toHaveBeenCalledOnce()
    expect(fixture.connection.release).not.toHaveBeenCalled()
    expect(fixture.connection.commit).not.toHaveBeenCalled()
  })

  it('creates a V4 session transactionally without updating the source V3 session', async () => {
    const fixture = fakePool([
      [[{ session_id: 11, user_id: 7, role: 'user', plan: 'pro', plan_expires_at: null }], []],
      [[], []],
      [{ insertId: 22, affectedRows: 1 }, []],
    ])
    const repository = createBridgeCredentialRepository(fixture.pool)

    await expect(repository.rotateFromLegacy(input)).resolves.toEqual({ userId: 7, generation: 1 })
    expect(fixture.connection.beginTransaction).toHaveBeenCalledOnce()
    expect(fixture.connection.commit).toHaveBeenCalledOnce()
    expect(fixture.connection.rollback).not.toHaveBeenCalled()
    const statements = fixture.execute.mock.calls.map(call => String(call[0]))
    expect(statements.some(sql => /INSERT INTO bridge_refresh_sessions/.test(sql))).toBe(true)
    expect(statements.some(sql => /UPDATE\s+bridge_refresh_sessions[\s\S]*source_refresh_session_id/.test(sql))).toBe(false)
    expect(statements[0]).not.toMatch(/s\.expires_at\s*>/)
  })

  it('rotates the same migration row and increments its generation', async () => {
    const fixture = fakePool([
      [[{ session_id: 11, user_id: 7, role: 'admin', plan: null, plan_expires_at: null }], []],
      [[{
        session_id: 22,
        user_id: 7,
        installation_id: 'installation-1',
        profile_id: 'default',
        generation: 3,
        revoked_at: null,
        migration_key: input.migrationKey,
      }], []],
      [{ affectedRows: 1 }, []],
    ])
    const repository = createBridgeCredentialRepository(fixture.pool)
    await expect(repository.rotateFromLegacy(input)).resolves.toEqual({ userId: 7, generation: 4 })
    const updateCall = fixture.execute.mock.calls.find(call => /SET token_hash/.test(String(call[0])))
    expect(updateCall?.[1]).toEqual([
      input.replacementTokenHash,
      'smoke',
      '127.0.0.1',
      22,
    ])
  })

  it('rolls back and leaves no partial commit when persistence fails', async () => {
    const fixture = fakePool([
      [[{ session_id: 11, user_id: 7, role: 'user', plan: 'pro', plan_expires_at: null }], []],
      [[], []],
      new Error('simulated_storage_failure'),
    ])
    const repository = createBridgeCredentialRepository(fixture.pool)
    await expect(repository.rotateFromLegacy(input)).rejects.toThrow('simulated_storage_failure')
    expect(fixture.connection.rollback).toHaveBeenCalledOnce()
    expect(fixture.connection.commit).not.toHaveBeenCalled()
    expect(fixture.connection.release).toHaveBeenCalledOnce()
  })

  it('rejects reusing one V3 session for a different V4 binding', async () => {
    const fixture = fakePool([
      [[{ session_id: 11, user_id: 7, role: 'user', plan: 'pro', plan_expires_at: null }], []],
      [[{
        session_id: 22,
        user_id: 7,
        installation_id: 'another-installation',
        profile_id: 'another-profile',
        generation: 1,
        revoked_at: null,
        migration_key: 'e'.repeat(64),
      }], []],
    ])
    const repository = createBridgeCredentialRepository(fixture.pool)
    await expect(repository.rotateFromLegacy(input)).rejects.toMatchObject({
      code: 'bridge_credential_migration_conflict',
      status: 409,
    })
    expect(fixture.connection.rollback).toHaveBeenCalledOnce()
    expect(fixture.execute).toHaveBeenCalledTimes(2)
  })

  it.each(['pro', 'plus', 'free'])('keeps %s device refresh durable; capacity controls connection admission', async plan => {
    const fixture = fakePool([
      [[{
        session_id: 22,
        user_id: 7,
        installation_id: 'installation-1',
        profile_id: 'default',
        generation: 2,
        revoked_at: null,
        role: 'user',
        plan,
        plan_expires_at: null,
      }], []],
      [{ affectedRows: 1 }, []],
    ])
    const repository = createBridgeCredentialRepository(fixture.pool)
    await expect(repository.useDeviceRefresh({
      tokenHash: input.replacementTokenHash,
      installationId: input.installationId,
      profileId: input.profileId,
      userAgent: input.userAgent,
      ipAddress: input.ipAddress,
    })).resolves.toEqual({
      userId: 7,
      installationId: 'installation-1',
      profileId: 'default',
      generation: 2,
    })
    expect(String(fixture.execute.mock.calls[0]?.[0])).not.toMatch(/s\.expires_at\s*>/)
  })
})
