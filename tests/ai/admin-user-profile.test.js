import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  beijingNow:vi.fn(() => '2026-08-10 10:00:00'),
  queryOne:vi.fn(),
  queryRun:vi.fn(),
  withTransaction:vi.fn(),
  logAudit:vi.fn(),
}))
const transaction = vi.hoisted(() => ({ run:vi.fn() }))
const bridge = vi.hoisted(() => ({
  assertBridgeEligible:vi.fn(user => {
    const plan = String(user?.plan || 'free').toLowerCase()
    const expiry = String(user?.plan_expires_at || '').slice(0, 10)
    if (String(user?.role || '').toLowerCase() === 'admin') return
    if (plan !== 'pro' || (expiry && expiry < '2026-08-10')) {
      throw Object.assign(new Error('bridge_membership_required'), { code:'bridge_membership_required' })
    }
  }),
  revokeBridgeRefreshSessions:vi.fn(),
}))
const sockets = vi.hoisted(() => ({
  disconnectUserBridgeConnections:vi.fn(),
  disconnectUserSockets:vi.fn(),
}))
const passwordHash = vi.hoisted(() => vi.fn())

vi.mock('../../server/db.js', () => db)
vi.mock('bcryptjs', () => ({ default:{ hash:passwordHash } }))
vi.mock('../../server/bridge-auth-session.js', () => bridge)
vi.mock('../../server/bridge-ws.js', () => sockets)

import { updateAdminUserProfile } from '../../server/routes/ai/admin-user-profile.js'

describe('operations user profile editing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    db.queryOne.mockResolvedValue({ id:7, email:'user@example.com', phone:'13800000000', nickname:'用户',
      avatar:'', role:'user', plan:'free', plan_expires_at:null, plan_source:null })
    db.queryRun.mockResolvedValue({ affectedRows:1 })
    transaction.run.mockResolvedValue([{ affectedRows:1 }, []])
    db.withTransaction.mockImplementation(callback => callback(transaction.run))
    passwordHash.mockResolvedValue('hashed-password')
  })

  it('updates plan, preserves the selected expiry day and never audits plaintext passwords', async () => {
    const result = await updateAdminUserProfile({ actorUserId:1, targetUserId:7, input:{
      plan:'pro', expires_at:'2026-12-31', password:'Newpass2026',
    } })

    expect(result).toMatchObject({ plan:'pro', plan_expires_at:'2026-12-31 23:59:59', password_reset:true })
    expect(passwordHash).toHaveBeenCalledWith('Newpass2026', 10)
    const [sql, params] = transaction.run.mock.calls[0]
    expect(sql).toContain('plan_expires_at = ?')
    expect(params).toContain('2026-12-31 23:59:59')
    expect(params).toContain('hashed-password')
    expect(params).not.toContain('Newpass2026')
    expect(db.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      userId:1, action:'admin_user_profile_updated', targetId:7,
    }))
    expect(db.logAudit.mock.calls[0][0].detail).not.toContain('Newpass2026')
    expect(bridge.revokeBridgeRefreshSessions).toHaveBeenCalledWith(7, { run:transaction.run })
    expect(sockets.disconnectUserSockets).toHaveBeenCalledWith(7, 'Password reset by administrator')
  })

  it('clears expiry and membership source when switching to free', async () => {
    db.queryOne.mockResolvedValue({ id:7, email:'user@example.com', phone:null, plan:'pro', plan_expires_at:'2026-12-31 23:59:59', plan_source:'paid' })
    await updateAdminUserProfile({ actorUserId:1, targetUserId:7, input:{ plan:'free', expires_at:'2027-01-01' } })
    const [sql, params] = db.queryRun.mock.calls[0]
    expect(sql).toContain('plan_source = NULL')
    const planIndex = sql.split(', ').findIndex(fragment => fragment.includes('plan = ?'))
    const expiryIndex = sql.split(', ').findIndex(fragment => fragment.includes('plan_expires_at = ?'))
    expect(params[planIndex]).toBe('free')
    expect(params[expiryIndex]).toBeNull()
    expect(sql).not.toContain('token_version = token_version + 1')
    expect(passwordHash).not.toHaveBeenCalled()
    expect(db.withTransaction).not.toHaveBeenCalled()
    expect(bridge.revokeBridgeRefreshSessions).not.toHaveBeenCalled()
    expect(sockets.disconnectUserSockets).not.toHaveBeenCalled()
    expect(sockets.disconnectUserBridgeConnections).toHaveBeenCalledWith(7, 'bridge_membership_required')
    expect(JSON.parse(db.logAudit.mock.calls[0][0].detail)).toMatchObject({
      security_credential_change:false,
      membership_change:true,
      profile_change:false,
      security_session_revoked:false,
      bridge_membership_paused:true,
      bridge_membership_disconnect_error:null,
    })
  })

  it('keeps an active Bridge session when only extending membership expiry', async () => {
    db.queryOne.mockResolvedValue({ id:7, email:'user@example.com', phone:null, plan:'pro', plan_expires_at:'2026-12-31 23:59:59', plan_source:'paid' })
    await updateAdminUserProfile({ actorUserId:1, targetUserId:7, input:{ expires_at:'2027-12-31' } })
    expect(db.queryRun).toHaveBeenCalledTimes(1)
    expect(db.withTransaction).not.toHaveBeenCalled()
    expect(bridge.revokeBridgeRefreshSessions).not.toHaveBeenCalled()
    expect(sockets.disconnectUserSockets).not.toHaveBeenCalled()
    expect(sockets.disconnectUserBridgeConnections).not.toHaveBeenCalled()
    expect(JSON.parse(db.logAudit.mock.calls[0][0].detail)).toMatchObject({
      security_credential_change:false,
      membership_change:true,
      bridge_membership_paused:false,
      bridge_membership_disconnect_error:null,
    })
  })

  it('keeps an active Bridge session when shortening membership expiry but remaining valid', async () => {
    db.queryOne.mockResolvedValue({ id:7, email:'user@example.com', phone:null, plan:'pro', plan_expires_at:'2027-12-31 23:59:59', plan_source:'paid' })
    await updateAdminUserProfile({ actorUserId:1, targetUserId:7, input:{ expires_at:'2027-08-31' } })
    expect(db.withTransaction).not.toHaveBeenCalled()
    expect(bridge.revokeBridgeRefreshSessions).not.toHaveBeenCalled()
    expect(sockets.disconnectUserSockets).not.toHaveBeenCalled()
    expect(sockets.disconnectUserBridgeConnections).not.toHaveBeenCalled()
  })

  it.each([
    { plan:'free', expires_at:'2027-01-01' },
    { expires_at:'2026-07-01' },
  ])('only pauses Bridge connections when final membership is not eligible (%o)', async input => {
    db.queryOne.mockResolvedValue({ id:7, email:'user@example.com', phone:null, plan:'pro', plan_expires_at:'2026-12-31 23:59:59', plan_source:'paid' })
    await updateAdminUserProfile({ actorUserId:1, targetUserId:7, input })
    expect(db.withTransaction).not.toHaveBeenCalled()
    expect(bridge.revokeBridgeRefreshSessions).not.toHaveBeenCalled()
    expect(sockets.disconnectUserSockets).not.toHaveBeenCalled()
    expect(sockets.disconnectUserBridgeConnections).toHaveBeenCalledWith(7, 'bridge_membership_required')
  })

  it('restores an expired Pro membership without revoking its Bridge refresh session', async () => {
    db.queryOne.mockResolvedValue({ id:7, email:'user@example.com', phone:null, plan:'pro', plan_expires_at:'2026-07-01 23:59:59', plan_source:'paid' })
    await updateAdminUserProfile({ actorUserId:1, targetUserId:7, input:{ expires_at:'2026-12-31' } })
    expect(db.withTransaction).not.toHaveBeenCalled()
    expect(bridge.revokeBridgeRefreshSessions).not.toHaveBeenCalled()
    expect(sockets.disconnectUserSockets).not.toHaveBeenCalled()
    expect(sockets.disconnectUserBridgeConnections).not.toHaveBeenCalled()
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
    db.queryOne.mockResolvedValue({ id:9, email:'source@example.com', phone:null, plan:'pro', plan_expires_at:null, plan_source:'observer_source' })
    await expect(updateAdminUserProfile({ actorUserId:1, targetUserId:9, input:{ plan:'plus' } }))
      .rejects.toThrow('observer_source_plan_locked')
    await updateAdminUserProfile({ actorUserId:1, targetUserId:9, input:{ password:'Bridge2026' } })
    expect(db.withTransaction).toHaveBeenCalledTimes(1)
    expect(transaction.run).toHaveBeenCalledTimes(1)
  })

  it('updates the complete operations profile through the same validated write path', async () => {
    const result = await updateAdminUserProfile({ actorUserId:1, targetUserId:7, input:{
      nickname:'新昵称', email:'NEW@example.com', phone:'+8613900000000', role:'user',
    } })
    expect(result).toMatchObject({ nickname:'新昵称', email:'new@example.com', phone:'13900000000', role:'user' })
    expect(transaction.run.mock.calls[0][0]).toContain('nickname = ?')
    expect(sockets.disconnectUserSockets).toHaveBeenCalledWith(7, 'Account permissions changed')
  })

  it('keeps security session revocation for role changes', async () => {
    await updateAdminUserProfile({ actorUserId:1, targetUserId:7, input:{ role:'admin' } })
    const [sql] = transaction.run.mock.calls[0]
    expect(sql).toContain('token_version = token_version + 1')
    expect(bridge.revokeBridgeRefreshSessions).toHaveBeenCalledWith(7, { run:transaction.run })
    expect(sockets.disconnectUserSockets).toHaveBeenCalledWith(7, 'Account permissions changed')
    expect(sockets.disconnectUserBridgeConnections).not.toHaveBeenCalled()
  })

  it('allows a phone-registered user to remain without a bound email', async () => {
    db.queryOne.mockResolvedValue({ id:8, email:null, phone:'13800000000', nickname:'手机用户', avatar:'',
      role:'user', plan:'free', plan_expires_at:null, plan_source:null })
    const result = await updateAdminUserProfile({ actorUserId:1, targetUserId:8, input:{
      nickname:'手机用户', email:'', phone:'13800000000', role:'user', plan:'free', expires_at:'',
    } })
    expect(result).toMatchObject({ email:null, phone:'13800000000' })
    expect(db.queryRun.mock.calls[0][1]).toContain(null)
  })

  it('allows a legacy account without contact details to save other profile fields', async () => {
    db.queryOne.mockResolvedValue({ id:10, email:null, phone:null, nickname:'旧账户', avatar:'',
      role:'user', plan:'free', plan_expires_at:null, plan_source:null })
    const result = await updateAdminUserProfile({ actorUserId:1, targetUserId:10, input:{
      nickname:'旧账户新名称', email:'', phone:'', role:'user', plan:'free', expires_at:'',
    } })
    expect(result).toMatchObject({ email:null, phone:null, nickname:'旧账户新名称' })
    expect(db.queryRun).toHaveBeenCalledTimes(1)
    expect(sockets.disconnectUserSockets).not.toHaveBeenCalled()
  })

  it('does not revoke sessions for nickname, avatar or phone-only changes', async () => {
    await updateAdminUserProfile({ actorUserId:1, targetUserId:7, input:{
      nickname:'nickname-updated', avatar:'/avatar.png', phone:'+8613900000000',
    } })
    expect(db.withTransaction).not.toHaveBeenCalled()
    expect(db.queryRun).toHaveBeenCalledTimes(1)
    expect(bridge.revokeBridgeRefreshSessions).not.toHaveBeenCalled()
    expect(sockets.disconnectUserSockets).not.toHaveBeenCalled()
  })

  it('does not disconnect sockets when a sensitive profile transaction rolls back', async () => {
    db.withTransaction.mockRejectedValueOnce(new Error('profile transaction failed'))
    await expect(updateAdminUserProfile({ actorUserId:1, targetUserId:7, input:{ role:'admin' } }))
      .rejects.toThrow('profile transaction failed')
    expect(sockets.disconnectUserSockets).not.toHaveBeenCalled()
    expect(db.queryRun).not.toHaveBeenCalled()
  })

  it('does not disconnect Bridge connections when a membership update fails', async () => {
    db.queryOne.mockResolvedValue({ id:7, email:'user@example.com', phone:null, plan:'pro', plan_expires_at:'2026-12-31 23:59:59', plan_source:'paid' })
    db.queryRun.mockRejectedValueOnce(new Error('membership update failed'))
    await expect(updateAdminUserProfile({ actorUserId:1, targetUserId:7, input:{ plan:'free' } }))
      .rejects.toThrow('membership update failed')
    expect(sockets.disconnectUserBridgeConnections).not.toHaveBeenCalled()
    expect(db.logAudit).not.toHaveBeenCalled()
  })

  it('records a stable audit code when Bridge membership disconnect fails after commit', async () => {
    db.queryOne.mockResolvedValue({ id:7, email:'user@example.com', phone:null, plan:'pro', plan_expires_at:'2027-12-31 23:59:59', plan_source:'paid' })
    sockets.disconnectUserBridgeConnections.mockRejectedValueOnce(new Error('bridge registry unavailable'))
    await updateAdminUserProfile({ actorUserId:1, targetUserId:7, input:{ plan:'free' } })
    expect(db.queryRun).toHaveBeenCalledTimes(1)
    expect(sockets.disconnectUserBridgeConnections).toHaveBeenCalledWith(7, 'bridge_membership_required')
    expect(JSON.parse(db.logAudit.mock.calls[0][0].detail)).toMatchObject({
      bridge_membership_paused:true,
      bridge_membership_disconnect_error:'bridge_membership_disconnect_failed',
    })
  })

  it('requires at least one login contact while keeping observer source email mandatory', async () => {
    db.queryOne.mockResolvedValueOnce({ id:8, email:null, phone:'13800000000', nickname:'手机用户', avatar:'',
      role:'user', plan:'free', plan_expires_at:null, plan_source:null })
    await expect(updateAdminUserProfile({ actorUserId:1, targetUserId:8, input:{ email:'', phone:'' } }))
      .rejects.toThrow('contact_method_required')

    db.queryOne.mockResolvedValueOnce({ id:9, email:'source@example.com', phone:'13800000000', nickname:'观摩源', avatar:'',
      role:'user', plan:'pro', plan_expires_at:null, plan_source:'observer_source' })
    await expect(updateAdminUserProfile({ actorUserId:1, targetUserId:9, input:{ email:'' } }))
      .rejects.toThrow('observer_source_email_required')
    expect(db.queryRun).not.toHaveBeenCalled()
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
