import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  queryOne:vi.fn(),
  queryRun:vi.fn(),
  logAudit:vi.fn(),
}))
const passwordHash = vi.hoisted(() => vi.fn())

vi.mock('../../server/db.js', () => db)
vi.mock('bcryptjs', () => ({ default:{ hash:passwordHash } }))

import { createObserverSourceAccount } from '../../server/routes/ai/observer-source-accounts.js'

describe('observer source account creation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    passwordHash.mockResolvedValue('secure-password-hash')
    db.queryOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id:42, uid:'OBS123', email:'source@example.com', nickname:'一号观摩源',
      role:'user', plan:'pro', plan_source:'observer_source',
    })
    db.queryRun.mockResolvedValue({ insertId:42, changes:1 })
    db.logAudit.mockResolvedValue(undefined)
  })

  it('creates a dedicated Pro user without persisting the plaintext password', async () => {
    const account = await createObserverSourceAccount(1, {
      email:' Source@Example.com ', nickname:'一号观摩源', password:'Bridge2026!',
    })

    expect(account).toMatchObject({ id:42, role:'user', plan:'pro', plan_source:'observer_source' })
    expect(passwordHash).toHaveBeenCalledWith('Bridge2026!', 10)
    const [sql, params] = db.queryRun.mock.calls[0]
    expect(sql).toContain("'user', 'pro', NULL, 'observer_source'")
    expect(params).toContain('source@example.com')
    expect(params).toContain('secure-password-hash')
    expect(params).not.toContain('Bridge2026!')
    expect(db.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      userId:1, action:'observer_source_account_created', targetId:42,
    }))
    expect(db.logAudit.mock.calls[0][0].detail).not.toContain('Bridge2026!')
  })

  it.each([
    [{ email:'not-an-email', password:'Bridge2026!' }, 'observer_source_email_invalid'],
    [{ email:'source@example.com', password:'short' }, 'observer_source_password_invalid'],
    [{ email:'source@example.com', password:'abcdefgh' }, 'observer_source_password_invalid'],
  ])('rejects invalid credentials before writing', async (input, error) => {
    await expect(createObserverSourceAccount(1, input)).rejects.toThrow(error)
    expect(db.queryRun).not.toHaveBeenCalled()
  })

  it('rejects an email already owned by another account', async () => {
    db.queryOne.mockReset().mockResolvedValue({ id:7 })
    await expect(createObserverSourceAccount(1, {
      email:'source@example.com', password:'Bridge2026!',
    })).rejects.toThrow('observer_source_email_exists')
    expect(passwordHash).not.toHaveBeenCalled()
    expect(db.queryRun).not.toHaveBeenCalled()
  })

  it('normalizes duplicate-key races to a safe business error', async () => {
    db.queryRun.mockRejectedValue(Object.assign(new Error('duplicate'), { code:'ER_DUP_ENTRY' }))
    await expect(createObserverSourceAccount(1, {
      email:'source@example.com', password:'Bridge2026!',
    })).rejects.toThrow('observer_source_email_exists')
    expect(db.logAudit).not.toHaveBeenCalled()
  })
})
