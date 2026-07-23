import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  beijingNow:vi.fn(() => '2026-07-23 10:00:00'),
  queryOne:vi.fn(),
  queryRun:vi.fn(),
  logAudit:vi.fn(),
}))
const passwordHash = vi.hoisted(() => vi.fn())

vi.mock('../../server/db.js', () => db)
vi.mock('bcryptjs', () => ({ default:{ hash:passwordHash } }))
vi.mock('../../server/bridge-auth-session.js', () => ({ revokeBridgeRefreshSessions:vi.fn() }))

import { updateAdminUserProfile } from '../../server/routes/ai/admin-user-profile.js'

describe('operations user profile editing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    db.queryOne.mockResolvedValue({ id:7, email:'user@example.com', phone:'13800000000', nickname:'用户',
      avatar:'', role:'user', plan:'free', plan_expires_at:null, plan_source:null })
    db.queryRun.mockResolvedValue({ affectedRows:1 })
    passwordHash.mockResolvedValue('hashed-password')
  })

  it('updates plan, preserves the selected expiry day and never audits plaintext passwords', async () => {
    const result = await updateAdminUserProfile({ actorUserId:1, targetUserId:7, input:{
      plan:'pro', expires_at:'2026-12-31', password:'Newpass2026',
    } })

    expect(result).toMatchObject({ plan:'pro', plan_expires_at:'2026-12-31 23:59:59', password_reset:true })
    expect(passwordHash).toHaveBeenCalledWith('Newpass2026', 10)
    const [sql, params] = db.queryRun.mock.calls[0]
    expect(sql).toContain('plan_expires_at = ?')
    expect(params).toContain('2026-12-31 23:59:59')
    expect(params).toContain('hashed-password')
    expect(params).not.toContain('Newpass2026')
    expect(db.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      userId:1, action:'admin_user_profile_updated', targetId:7,
    }))
    expect(db.logAudit.mock.calls[0][0].detail).not.toContain('Newpass2026')
  })

  it('clears expiry and membership source when switching to free', async () => {
    db.queryOne.mockResolvedValue({ id:7, plan:'pro', plan_expires_at:'2026-12-31 23:59:59', plan_source:'paid' })
    await updateAdminUserProfile({ actorUserId:1, targetUserId:7, input:{ plan:'free', expires_at:'2027-01-01' } })
    const [sql, params] = db.queryRun.mock.calls[0]
    expect(sql).toContain('plan_source = NULL')
    const planIndex = sql.split(', ').findIndex(fragment => fragment.includes('plan = ?'))
    const expiryIndex = sql.split(', ').findIndex(fragment => fragment.includes('plan_expires_at = ?'))
    expect(params[planIndex]).toBe('free')
    expect(params[expiryIndex]).toBeNull()
    expect(passwordHash).not.toHaveBeenCalled()
  })

  it.each([
    [{ plan:'vip' }, 'membership_plan_invalid'],
    [{ plan:'pro', expires_at:'2026-02-30' }, 'membership_expiry_invalid'],
    [{ plan:'pro', password:'abcdefgh' }, 'password_strength_insufficient'],
  ])('rejects invalid profile input', async (input, code) => {
    await expect(updateAdminUserProfile({ actorUserId:1, targetUserId:7, input })).rejects.toThrow(code)
    expect(db.queryRun).not.toHaveBeenCalled()
  })

  it('keeps dedicated observer source accounts on Pro while allowing password reset', async () => {
    db.queryOne.mockResolvedValue({ id:9, plan:'pro', plan_expires_at:null, plan_source:'observer_source' })
    await expect(updateAdminUserProfile({ actorUserId:1, targetUserId:9, input:{ plan:'plus' } }))
      .rejects.toThrow('observer_source_plan_locked')
    await updateAdminUserProfile({ actorUserId:1, targetUserId:9, input:{ password:'Bridge2026' } })
    expect(db.queryRun).toHaveBeenCalledTimes(1)
  })

  it('updates the complete operations profile through the same validated write path', async () => {
    const result = await updateAdminUserProfile({ actorUserId:1, targetUserId:7, input:{
      nickname:'新昵称', email:'NEW@example.com', phone:'+8613900000000', role:'user',
    } })
    expect(result).toMatchObject({ nickname:'新昵称', email:'new@example.com', phone:'13900000000', role:'user' })
    expect(db.queryRun.mock.calls[0][0]).toContain('nickname = ?')
  })

  it('does not allow the final administrator to be downgraded', async () => {
    db.queryOne
      .mockResolvedValueOnce({ id:1, email:'admin@example.com', phone:null, nickname:'管理员', avatar:'',
        role:'admin', plan:'pro', plan_expires_at:null, plan_source:null })
      .mockResolvedValueOnce({ count:1 })
    await expect(updateAdminUserProfile({ actorUserId:1, targetUserId:1, input:{ role:'user' } }))
      .rejects.toThrow('last_admin_required')
    expect(db.queryRun).not.toHaveBeenCalled()
  })
})
