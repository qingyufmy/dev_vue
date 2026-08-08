import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  queryOne:vi.fn(),
  withTransaction:vi.fn(),
}))
const bridge = vi.hoisted(() => ({ disconnectUserSockets:vi.fn() }))
const passwordHash = vi.hoisted(() => vi.fn())

vi.mock('../../server/db.js', () => db)
vi.mock('bcryptjs', () => ({ default:{ hash:passwordHash } }))
vi.mock('../../server/bridge-ws.js', () => bridge)

import { anonymizeAdminUser } from '../../server/admin/user-deletion.js'

describe('admin user anonymization session revocation', () => {
  const run = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    db.queryOne.mockResolvedValue({ id:7, email:'user@example.com', role:'user' })
    run.mockResolvedValue([{ affectedRows:1 }, []])
    db.withTransaction.mockImplementation(callback => callback(run))
    passwordHash.mockResolvedValue('destroyed-password-hash')
  })

  it('increments token version, revokes refresh sessions and disconnects after commit', async () => {
    await expect(anonymizeAdminUser({
      actor:{ id:1, email:'admin@example.com', nickname:'Admin' }, targetUserId:7,
    })).resolves.toMatchObject({ id:7, email:'user@example.com' })

    const sqls = run.mock.calls.map(([sql]) => sql)
    expect(sqls.some(sql => sql.includes('token_version = token_version + 1'))).toBe(true)
    expect(sqls.some(sql => sql.includes('bridge_refresh_sessions') && sql.includes('revoked_at'))).toBe(true)
    expect(sqls.some(sql => sql.includes('bridge_connection_status'))).toBe(false)
    expect(bridge.disconnectUserSockets).toHaveBeenCalledWith(7, 'User account anonymized')
  })

  it('does not disconnect sockets when the anonymization transaction fails', async () => {
    db.withTransaction.mockImplementation(async callback => callback(async sql => {
      if (sql.includes('UPDATE users SET')) throw new Error('rollback')
      return [{ affectedRows:1 }, []]
    }))

    await expect(anonymizeAdminUser({
      actor:{ id:1, email:'admin@example.com', nickname:'Admin' }, targetUserId:7,
    })).rejects.toThrow('rollback')
    expect(bridge.disconnectUserSockets).not.toHaveBeenCalled()
  })

  it('keeps the final administrator protected and does not start a transaction', async () => {
    db.queryOne.mockResolvedValue({ id:7, email:'admin@example.com', role:'admin' })
    await expect(anonymizeAdminUser({
      actor:{ id:1 }, targetUserId:7,
    })).rejects.toThrow('admin_user_cannot_be_deleted')
    expect(db.withTransaction).not.toHaveBeenCalled()
    expect(bridge.disconnectUserSockets).not.toHaveBeenCalled()
  })
})
