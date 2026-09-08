import type { Pool } from 'mysql2/promise'
import { expect, it, vi } from 'vitest'
import { MysqlAuthRepository } from '../src/modules/auth/infrastructure/mysql-auth-repository.js'

const now = new Date('2026-09-09T00:00:00.000Z')
function fixture(id: unknown = '42', parent: unknown = '41') {
  const row = { id, user_id: 7, client_id: 'trade-web', parent_session_id: parent, auth_session_id: parent,
    auth_time_utc: now, mfa_level: 'none', session_version: 3, idle_expires_at_utc: null,
    absolute_expires_at_utc: new Date(now.getTime() + 60000), revoked_at_utc: null }
  const connection = {
    execute: vi.fn(async (sql: string) => sql.includes('UPDATE auth_authorization_codes') ? [{ affectedRows: 1 }] : [[row]]),
    beginTransaction: vi.fn(async () => {}), commit: vi.fn(async () => {}), rollback: vi.fn(async () => {}), release: vi.fn(),
  }
  const pool = { execute: connection.execute, getConnection: vi.fn(async () => connection) }
  return { row, connection, repository: new MysqlAuthRepository(pool as unknown as Pool) }
}

it('normalizes mysql BIGINT strings for session lookup by hash and id', async () => {
  const f = fixture()
  for (const session of [await f.repository.findActiveSession('fixture', now), await f.repository.findActiveSessionById(42, now)]) {
    expect(session).toMatchObject({ id: 42, parentSessionId: 41, userId: 7, sessionVersion: 3 })
    expect(Number.isSafeInteger(session?.id)).toBe(true)
  }
})
it('retains numeric ids and nullable root session parent', async () => {
  const f = fixture(42, null)
  expect(await f.repository.findActiveSession('fixture', now)).toMatchObject({ id: 42, parentSessionId: null })
})
it.each(['9007199254740992', 9007199254740992, '01', '1e2', '0', '-1', '', null])('rejects unsafe or noncanonical session identity %j', async value => {
  const f = fixture(value)
  await expect(f.repository.findActiveSession('fixture', now)).rejects.toThrow(/^auth_storage_identity_invalid$/)
})
it('rejects an unsafe parent identity rather than silently rounding it', async () => {
  const f = fixture('42', '9007199254740992')
  await expect(f.repository.findActiveSession('fixture', now)).rejects.toThrow(/^auth_storage_identity_invalid$/)
})
it('normalizes consumed authorization code and parent session ids inside the transaction', async () => {
  const f = fixture()
  expect(await f.repository.consumeAuthorizationCode('fixture', now)).toMatchObject({ id: 42, authSessionId: 41 })
  expect(f.connection.execute).toHaveBeenLastCalledWith(expect.stringContaining('UPDATE auth_authorization_codes'), [now, 42])
  expect(f.connection.commit).toHaveBeenCalledOnce()
})
it('invalid code identities roll back before the consumed marker is written', async () => {
  const f = fixture('42', '9007199254740992')
  await expect(f.repository.consumeAuthorizationCode('fixture', now)).rejects.toThrow(/^auth_storage_identity_invalid$/)
  expect(f.connection.execute).toHaveBeenCalledOnce()
  expect(f.connection.rollback).toHaveBeenCalledOnce(); expect(f.connection.commit).not.toHaveBeenCalled()
})
