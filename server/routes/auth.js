import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { v4 as uuidv4 } from 'uuid'
import crypto from 'crypto'
import { queryOne, queryAll, queryRun, logAudit } from '../db.js'
import { generateToken, authMiddleware } from '../middleware/auth.js'
import nodemailer from 'nodemailer'
import { sendVerificationSms } from '../sms.js'
import { generateCaptcha, verifyCaptcha } from '../captcha.js'
import { decorateMembership } from '../membership.js'
import { createBridgeRefreshSession, useBridgeRefreshSession, revokeBridgeRefreshSessions } from '../bridge-auth-session.js'

const router = Router()

function normalizePhone(p) {
  if (!p) return p
  return p.replace(/^\+86/, '')
}

const planLabelMap = { free: '免费版', plus: 'Plus', pro: 'Pro' }
const planDescMap = { free: '公开视频和语录', plus: '新视频即时解锁、图解、测验和 AI 交易观摩', pro: '全部课程和 AI 全自动交易' }

async function getGiftConfig() {
  const rows = await queryAll(
    "SELECT `key`, value FROM system_config WHERE category = 'auth_toggle' AND `key` IN ('gift_enabled','gift_plan','gift_duration','gift_duration_unit')"
  )
  const map = Object.fromEntries(rows.map(r => [r.key, r.value]))
  const enabled = map.gift_enabled !== 'false'
  const VALID_PLANS = ['free', 'plus', 'pro']
  const plan = VALID_PLANS.includes(map.gift_plan) ? map.gift_plan : 'pro'
  const duration = Math.min(3650, Math.max(1, parseInt(map.gift_duration) || 30))
  const unit = map.gift_duration_unit === 'months' ? 'MONTH' : 'DAY'
  return { enabled, plan, duration, unit, unitLabel: unit === 'MONTH' ? '个月' : '天' }
}

async function getAuthToggles() {
  const rows = await queryAll("SELECT `key`, `value` FROM system_config WHERE category = 'auth_toggle'")
  const map = {}
  for (const r of rows) map[r.key] = r.value
  return map
}

async function sendSmtpEmail(to, subject, html) {
  const rows = await queryAll("SELECT `key`, `value` FROM system_config WHERE category = 'smtp'")
  const cfg = {}
  for (const r of rows) cfg[r.key] = r.value
  if (!cfg.host || !cfg.user) return false
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: Number(cfg.port) || 587,
    secure: cfg.secure === 'true',
    auth: { user: cfg.user, pass: cfg.pass },
  })
  await transporter.sendMail({
    from: { name: cfg.from_name || '量见课堂', address: cfg.from || cfg.user },
    to,
    subject,
    html,
  })
  return true
}

// Brute-force protection for verification codes
const _verifyFailedAttempts = new Map() // key: target -> { count, lockedUntil }
const MAX_VERIFY_ATTEMPTS = 5
const VERIFY_LOCKOUT_MS = 15 * 60 * 1000

// Periodic cleanup: remove expired lockout entries every 15 minutes
setInterval(() => {
  const now = Date.now()
  for (const [key, entry] of _verifyFailedAttempts) {
    if (now >= entry.lockedUntil) _verifyFailedAttempts.delete(key)
  }
}, 15 * 60 * 1000)

function checkVerifyLockout(target) {
  const entry = _verifyFailedAttempts.get(target)
  if (!entry) return null
  if (Date.now() < entry.lockedUntil) return `验证码已锁定，请 ${Math.ceil((entry.lockedUntil - Date.now()) / 60000)} 分钟后重试`
  if (Date.now() >= entry.lockedUntil) { _verifyFailedAttempts.delete(target); return null }
  return null
}

function recordVerifyFailure(target) {
  const entry = _verifyFailedAttempts.get(target) || { count: 0, lockedUntil: 0 }
  entry.count++
  if (entry.count >= MAX_VERIFY_ATTEMPTS) entry.lockedUntil = Date.now() + VERIFY_LOCKOUT_MS
  _verifyFailedAttempts.set(target, entry)
}

function clearVerifyFailures(target) {
  _verifyFailedAttempts.delete(target)
}

async function checkSmsRateLimit(phone) {
  const rows = await queryAll(
    `SELECT created_at FROM verification_codes
     WHERE (phone = ?) AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)
     ORDER BY created_at DESC`,
    [phone]
  )

  const quarter = rows.filter(r => {
    const diff = Date.now() - new Date(r.created_at).getTime()
    return diff < 15 * 60 * 1000
  })
  if (quarter.length >= 5) return { ok: false, error: '15分钟内最多发送5次，请稍后再试' }

  return { ok: true }
}

function generateReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 10; i++) {
    code += chars[crypto.randomInt(chars.length)]
  }
  return code
}

router.get('/auth-methods', async (req, res) => {
  try {
    const toggleMap = await getAuthToggles()
    const emailEnabled = toggleMap.email_enabled !== 'false'
    const phoneEnabled = toggleMap.phone_enabled !== 'false'
    res.json({ ok: true, emailEnabled, phoneEnabled })
  } catch (err) {
    console.error('[auth-methods]', err.message)
    res.json({ ok: true, emailEnabled: true, phoneEnabled: true })
  }
})

router.get('/captcha', async (req, res) => {
  try {
    const { id, svg } = generateCaptcha()
    res.json({ ok: true, id, svg })
  } catch (err) {
    console.error('[captcha]', err.message)
    res.json({ ok: false, error: '生成验证码失败' })
  }
})

router.post('/register', async (req, res) => {
  try {
    const { email, phone: rawPhone, password, nickname, referral, referralCode, verifyToken, authMethod } = req.body
    const phone = normalizePhone(rawPhone)
    const method = authMethod || (phone ? 'phone' : 'email')
    const gift = await getGiftConfig()
    const regPlan = gift.enabled ? gift.plan : 'free'
    const regPlanSource = gift.enabled ? 'gift' : null

    // Check auth toggles
    try {
      const toggleMap = await getAuthToggles()
      if (method === 'email' && toggleMap.email_enabled === 'false') {
        return res.json({ ok: false, error: '邮箱注册已关闭' })
      }
      if (method === 'phone' && toggleMap.phone_enabled === 'false') {
        return res.json({ ok: false, error: '手机注册已关闭' })
      }
    } catch (toggleErr) {
      console.error('[register] toggle check error:', toggleErr.message)
    }

    if (method === 'phone') {
      if (!phone || !password) return res.json({ ok: false, error: '手机号和密码不能为空' })
      if (password.length < 8) return res.json({ ok: false, error: '密码至少8位' })
      if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) return res.json({ ok: false, error: '密码需包含字母和数字' })
      if (!verifyToken) return res.json({ ok: false, error: '请先完成手机验证' })

      const tokenRecord = await queryOne(
        'SELECT id FROM verification_codes WHERE (phone = ? OR phone = ?) AND verify_token = ? AND purpose = ? AND expires_at > NOW() AND token_used = 0',
        [phone, phone, verifyToken, 'register']
      )
      if (!tokenRecord) return res.json({ ok: false, error: '手机验证已过期，请重新验证' })

      const existing = await queryOne('SELECT id FROM users WHERE phone = ? OR phone = ?', [phone, phone])
      if (existing) return res.json({ ok: false, error: '该手机号已注册' })

      const hash = await bcrypt.hash(password, 10)
      const code = referralCode || generateReferralCode()
      const ref = referral || null

      let referredBy = null
      if (ref) {
        const referrer = await queryOne('SELECT id FROM users WHERE referral_code = ?', [ref.toUpperCase()])
        if (referrer) referredBy = ref.toUpperCase()
      }

      const result = await queryRun(`
        INSERT INTO users (phone, password, nickname, referral_code, referred_by, uid, plan, plan_expires_at, plan_source, auth_method, phone_verified)
        VALUES (?, ?, ?, ?, ?, ?, ?, ${gift.enabled ? `DATE_ADD(NOW(), INTERVAL ${gift.duration} ${gift.unit})` : 'NULL'}, ?, 'phone', 1)
      `, [phone, hash, nickname || '手机用户', code, referredBy, 'WS' + String(Date.now()).slice(-6), regPlan, regPlanSource])

      const token = generateToken(result.insertId)
      const user = await queryOne('SELECT id, uid, phone, nickname, avatar, role, plan, plan_source, plan_expires_at, referral_code, referral_credit FROM users WHERE id = ?', [result.insertId])
      user.name = user.nickname
      user.authMethod = 'phone'
      user.planExpiresAt = user.plan_expires_at || ''
      user.planSource = user.plan_source || null
      Object.assign(user, decorateMembership(user))

      if (referredBy) {
        const referrer = await queryOne('SELECT id FROM users WHERE referral_code = ?', [referredBy])
        if (referrer) await queryRun('INSERT INTO referrals (referrer_id, referred_id, status) VALUES (?, ?, ?)', [referrer.id, result.insertId, 'pending'])
      }

      await queryRun('UPDATE verification_codes SET used = 1, token_used = 1 WHERE id = ?', [tokenRecord.id])
      await queryRun('INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)', [result.insertId, 'system', '欢迎加入量见课堂', '您的账户已创建成功，开始学习吧！'])
      if (gift.enabled && regPlan !== 'free') {
        await queryRun('INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)', [result.insertId, 'system', '🎁 新会员福利', `已为您赠送 ${gift.duration}${gift.unitLabel} ${planLabelMap[regPlan] || regPlan} 体验，尽享${planDescMap[regPlan] || '全部课程'}！`])
      }

      logAudit({ userId: result.insertId, action: 'register', ip: req.ip, userAgent: req.get('user-agent') })
      return res.json({ ok: true, token, user })
    }

    // Email registration (original logic)
    if (!email || !password) return res.json({ ok: false, error: '邮箱和密码不能为空' })
    if (password.length < 8) return res.json({ ok: false, error: '密码至少8位' })
    if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) return res.json({ ok: false, error: '密码需包含字母和数字' })

    const existing = await queryOne('SELECT id FROM users WHERE email = ?', [email])
    if (existing) return res.json({ ok: false, error: '该邮箱已注册' })

    const hash = await bcrypt.hash(password, 10)
    const code = referralCode || generateReferralCode()
    const ref = referral || null

    let referredBy = null
    if (ref) {
      const referrer = await queryOne('SELECT id FROM users WHERE referral_code = ?', [ref.toUpperCase()])
      if (referrer) referredBy = ref.toUpperCase()
    }

    const result = await queryRun(`
      INSERT INTO users (email, password, nickname, referral_code, referred_by, uid, plan, plan_expires_at, plan_source, auth_method, email_verified)
      VALUES (?, ?, ?, ?, ?, ?, ?, ${gift.enabled ? `DATE_ADD(NOW(), INTERVAL ${gift.duration} ${gift.unit})` : 'NULL'}, ?, 'email', 1)
    `, [email, hash, nickname || email.split('@')[0], code, referredBy, 'WS' + String(Date.now()).slice(-6), regPlan, regPlanSource])

    const token = generateToken(result.insertId)
    const user = await queryOne('SELECT id, uid, email, nickname, avatar, role, plan, plan_source, plan_expires_at, referral_code, referral_credit FROM users WHERE id = ?', [result.insertId])
    user.name = user.nickname
    user.authMethod = 'email'
    user.planExpiresAt = user.plan_expires_at || ''
    user.planSource = user.plan_source || null
    Object.assign(user, decorateMembership(user))

    if (referredBy) {
      const referrer = await queryOne('SELECT id FROM users WHERE referral_code = ?', [referredBy])
      if (referrer) await queryRun('INSERT INTO referrals (referrer_id, referred_id, status) VALUES (?, ?, ?)', [referrer.id, result.insertId, 'pending'])
    }

    await queryRun('INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)', [result.insertId, 'system', '欢迎加入量见课堂', '您的账户已创建成功，开始学习吧！'])
    if (gift.enabled && regPlan !== 'free') {
      await queryRun('INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)', [result.insertId, 'system', '🎁 新会员福利', `已为您赠送 ${gift.duration}${gift.unitLabel} ${planLabelMap[regPlan] || regPlan} 体验，尽享${planDescMap[regPlan] || '全部课程'}！`])
    }

    logAudit({ userId: result.insertId, action: 'register', ip: req.ip, userAgent: req.get('user-agent') })

    res.json({ ok: true, token, user })
  } catch (err) {
    console.error('Register error:', err)
    res.json({ ok: false, error: '注册失败，请稍后重试' })
  }
})

router.post('/auth/bridge-session', authMiddleware, async (req, res) => {
  try {
    const session = await createBridgeRefreshSession(req.user, { userAgent: req.get('user-agent'), ip: req.ip })
    res.json({ ok: true, refreshToken: session.refreshToken, refreshExpiresInSeconds: session.expiresInSeconds })
  } catch (err) {
    const membershipBlocked = err.code === 'bridge_membership_required'
    res.status(membershipBlocked ? 403 : 500).json({
      ok: false,
      code: err.code || 'bridge_session_failed',
      error: membershipBlocked ? '当前会员状态不能使用桥接软件' : '桥接登录会话创建失败，请稍后重试',
    })
  }
})

router.post('/auth/bridge-refresh', async (req, res) => {
  try {
    const session = await useBridgeRefreshSession(req.body?.refreshToken, {
      userAgent: req.get('user-agent'), ip: req.ip,
    })
    res.json({
      ok: true,
      token: generateToken(session.user.id),
      refreshExpiresInSeconds: session.expiresInSeconds,
    })
  } catch (err) {
    const membershipBlocked = err.code === 'bridge_membership_required'
    res.status(membershipBlocked ? 403 : 401).json({
      ok: false,
      code: err.code || 'bridge_refresh_invalid',
      error: membershipBlocked ? '会员已过期或当前等级不能使用桥接软件' : '桥接登录已过期，请重新登录',
    })
  }
})

router.post('/auth/bridge-revoke', authMiddleware, async (req, res) => {
  await revokeBridgeRefreshSessions(req.user.id)
  res.json({ ok: true })
})

router.post('/login', async (req, res) => {
  try {
    const { email, phone: rawPhone, password, method, verifyToken, client } = req.body
    const phone = normalizePhone(rawPhone)
    const loginId = phone || email
    if (!loginId) return res.json({ ok: false, error: '请输入邮箱或手机号' })

    // Check auth toggles
    try {
      const toggleMap = await getAuthToggles()
      if (phone && toggleMap.phone_enabled === 'false') {
        return res.json({ ok: false, error: '手机登录已关闭' })
      }
      if (email && !phone && toggleMap.email_enabled === 'false') {
        return res.json({ ok: false, error: '邮箱登录已关闭' })
      }
    } catch (toggleErr) {
      console.error('[login] toggle check error:', toggleErr.message)
    }

    const user = phone
      ? await queryOne("SELECT * FROM users WHERE phone = ? AND deletion_status = 'active' AND deleted_at IS NULL", [phone])
      : await queryOne("SELECT * FROM users WHERE email = ? AND deletion_status = 'active' AND deleted_at IS NULL", [email])
    if (!user) return res.json({ ok: false, error: '账号或密码错误' })

    let tokenRecord = null

    // Password login
    if (!method || method === 'password') {
      if (!password) return res.json({ ok: false, error: '请输入密码' })
      if (!await bcrypt.compare(password, user.password)) return res.json({ ok: false, error: '账号或密码错误' })
    }
    // Code login — verifyToken must match a server-issued token
    else if (method === 'code') {
      if (!verifyToken) return res.json({ ok: false, error: '请先完成验证' })
      tokenRecord = phone
        ? await queryOne(
            'SELECT id FROM verification_codes WHERE (phone = ? OR phone = ?) AND verify_token = ? AND purpose = ? AND expires_at > NOW() AND token_used = 0',
            [phone, phone, verifyToken, 'login']
          )
        : await queryOne(
            'SELECT id FROM verification_codes WHERE email = ? AND verify_token = ? AND purpose = ? AND expires_at > NOW() AND token_used = 0',
            [email, verifyToken, 'login']
          )
      if (!tokenRecord) return res.json({ ok: false, error: '验证已过期，请重新验证' })
    }
    else {
      return res.json({ ok: false, error: '不支持的登录方式' })
    }

    const token = generateToken(user.id)
    const { password: _, ...safeUser } = user
    safeUser.name = user.nickname
    safeUser.isAdmin = user.role === 'admin'
    safeUser.planExpiresAt = user.plan_expires_at || ''
    safeUser.planPeriod = user.plan_period || ''
    safeUser.planSource = user.plan_source || null
    const membership = decorateMembership(user)
    safeUser.membershipExpired = membership.membershipExpired
    safeUser.effectivePlan = membership.effectivePlan
    safeUser.createdAt = user.created_at || ''
    safeUser.authMethod = user.auth_method || 'email'
    safeUser.telegramBinding = getTelegramBinding(user)

    if (method === 'code' && tokenRecord) {
      await queryRun('UPDATE verification_codes SET token_used = 1 WHERE id = ?', [tokenRecord.id])
    }

    logAudit({ userId: user.id, action: 'login', ip: req.ip, userAgent: req.get('user-agent') })

    let bridgeSession = null
    if (client === 'bridge' && (user.role === 'admin' || membership.effectivePlan === 'pro')) {
      bridgeSession = await createBridgeRefreshSession(user, { userAgent: req.get('user-agent'), ip: req.ip })
    }

    res.json({
      ok: true,
      token,
      user: safeUser,
      ...(bridgeSession ? {
        refreshToken: bridgeSession.refreshToken,
        refreshExpiresInSeconds: bridgeSession.expiresInSeconds,
      } : {}),
    })
  } catch (err) {
    console.error('Login error:', err)
    res.json({ ok: false, error: '登录失败，请稍后重试' })
  }
})

function getTelegramBinding(user) {
  if (!user.telegram_id && !user.telegram_username) return null
  return {
    username: user.telegram_username || '',
    name: user.telegram_name || '',
    groupStatus: user.telegram_group_status || '',
    botStartedAt: user.telegram_bot_started_at || '',
    joinedAt: user.telegram_joined_at || '',
    lastInviteSentAt: user.telegram_last_invite_sent_at || '',
  }
}

router.post('/send-code', async (req, res) => {
  try {
    const { email, phone: rawPhone, purpose, captchaId, captchaAnswer } = req.body
    const targetEmail = email || req.user?.email
    const targetPhone = normalizePhone(rawPhone)
    if (!targetEmail && !targetPhone) return res.json({ ok: false, error: '请输入邮箱或手机号' })

    // Check auth toggles
    try {
      const toggleMap = await getAuthToggles()
      if (targetPhone && toggleMap.phone_enabled === 'false') {
        return res.json({ ok: false, error: '手机验证已关闭' })
      }
      if (targetEmail && !targetPhone && toggleMap.email_enabled === 'false') {
        return res.json({ ok: false, error: '邮箱验证已关闭' })
      }
    } catch (toggleErr) {
      console.error('[send-code] toggle check error:', toggleErr.message)
    }

    // Check registration BEFORE CAPTCHA (clear error message)
    if (targetPhone && purpose === 'register') {
      const existing = await queryOne('SELECT id FROM users WHERE phone = ? OR phone = ?', [targetPhone, targetPhone])
      if (existing) return res.json({ ok: false, error: '该手机号已注册，请直接登录' })
    }
    if (targetEmail && !targetPhone && purpose === 'register') {
      const existing = await queryOne('SELECT id FROM users WHERE email = ?', [targetEmail])
      if (existing) return res.json({ ok: false, error: '该邮箱已注册，请直接登录' })
    }

    // CAPTCHA verification (mandatory for phone)
    if (targetPhone) {
      if (!captchaId || !captchaAnswer) return res.json({ ok: false, error: '请输入图形验证码' })
      const captchaOk = verifyCaptcha(captchaId, captchaAnswer)
      if (!captchaOk) return res.json({ ok: false, error: '图形验证码错误' })
    } else if (captchaId) {
      if (!captchaAnswer) return res.json({ ok: false, error: '请输入图形验证码' })
      const captchaOk = verifyCaptcha(captchaId, captchaAnswer)
      if (!captchaOk) return res.json({ ok: false, error: '图形验证码错误' })
    }

    if (targetPhone) {
      // Rate limit check
      const rateCheck = await checkSmsRateLimit(targetPhone)
      if (!rateCheck.ok) return res.json({ ok: false, error: rateCheck.error })

      try {
        await sendVerificationSms(targetPhone, purpose || 'login')
      } catch (smsErr) {
        console.error('[send-code] SMS error:', smsErr.message)
        return res.json({ ok: false, error: '短信发送失败，请稍后重试' })
      }

      return res.json({ ok: true, message: '验证码已发送到您的手机' })
    }

    // Email flow (original)
    if (purpose === 'register') {
      const existing = await queryOne('SELECT id FROM users WHERE email = ?', [targetEmail])
      if (existing) return res.json({ ok: false, error: '该邮箱已注册' })
    }

      const code = String(crypto.randomInt(100000, 999999))
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000 + 8 * 3600_000).toISOString().replace('T', ' ').substring(0, 19)

    await queryRun('INSERT INTO verification_codes (email, code, purpose, expires_at) VALUES (?, ?, ?, ?)', [targetEmail, code, purpose || 'login', expiresAt])

    // Try to send email via SMTP config
    let emailSent = false
    try {
      emailSent = await sendSmtpEmail(targetEmail, '量见课堂 - 验证码', `<p>您的验证码是：<strong>${code}</strong>，10分钟内有效。</p>`)
    } catch (e) {
      console.error('Send email error:', e.message)
    }

    res.json({ ok: true, message: emailSent ? '验证码已发送到您的邮箱' : '验证码已发送（本地开发模式请查看控制台）' })
  } catch (err) {
    console.error('[send-code] FATAL:', err.message, err.stack)
    res.json({ ok: false, error: '发送验证码失败' })
  }
})

router.post('/verify-code', async (req, res) => {
  try {
    const { email, phone: rawPhone, code, purpose } = req.body
    const targetEmail = email || req.user?.email
    const targetPhone = normalizePhone(rawPhone)

    if (!targetEmail && !targetPhone) return res.json({ ok: false, error: '请输入邮箱或手机号' })

    const lockTarget = targetPhone || targetEmail
    const lockoutMsg = checkVerifyLockout(lockTarget)
    if (lockoutMsg) return res.json({ ok: false, error: lockoutMsg })

    const record = targetPhone
      ? await queryOne(`
          SELECT * FROM verification_codes
          WHERE (phone = ? OR phone = ?) AND code = ? AND purpose = ? AND used = 0 AND expires_at > NOW()
          ORDER BY created_at DESC LIMIT 1
        `, [targetPhone, targetPhone, code, purpose || 'login'])
      : await queryOne(`
          SELECT * FROM verification_codes
          WHERE email = ? AND code = ? AND purpose = ? AND used = 0 AND expires_at > NOW()
          ORDER BY created_at DESC LIMIT 1
        `, [targetEmail, code, purpose || 'login'])

    if (!record) {
      recordVerifyFailure(lockTarget)
      return res.json({ ok: false, error: '验证码无效或已过期' })
    }

    clearVerifyFailures(lockTarget)
    const verifyToken = uuidv4()
    await queryRun('UPDATE verification_codes SET used = 1, verify_token = ? WHERE id = ?', [verifyToken, record.id])
    res.json({ ok: true, message: '验证成功', token: verifyToken })
  } catch (err) {
    console.error('[verify-code]', err.message)
    res.json({ ok: false, error: '验证失败' })
  }
})

router.post('/reset-password', async (req, res) => {
  try {
    const { email, phone: rawPhone, code, newPassword, verifyToken } = req.body
    const targetEmail = email
    const targetPhone = normalizePhone(rawPhone)
    if ((!targetEmail && !targetPhone) || !newPassword) return res.json({ ok: false, error: '参数不完整' })
    if (newPassword.length < 8) return res.json({ ok: false, error: '新密码至少8位' })
    if (!/[a-zA-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) return res.json({ ok: false, error: '新密码需包含字母和数字' })

    // verifyToken flow
    if (verifyToken) {
      const tokenRecord = targetPhone
        ? await queryOne(
            'SELECT id FROM verification_codes WHERE (phone = ? OR phone = ?) AND verify_token = ? AND purpose = ? AND expires_at > NOW() AND token_used = 0',
            [targetPhone, targetPhone, verifyToken, 'reset']
          )
        : await queryOne(
            'SELECT id FROM verification_codes WHERE email = ? AND verify_token = ? AND purpose = ? AND expires_at > NOW() AND token_used = 0',
            [targetEmail, verifyToken, 'reset']
          )
      if (!tokenRecord) return res.json({ ok: false, error: '验证已过期，请重新验证' })

      const hash = await bcrypt.hash(newPassword, 10)
      if (targetPhone) {
        await queryRun("UPDATE users SET password = ?, updated_at = NOW() WHERE phone = ? OR phone = ?", [hash, targetPhone, targetPhone])
      } else {
        await queryRun("UPDATE users SET password = ?, updated_at = NOW() WHERE email = ?", [hash, targetEmail])
      }
      const resetUser = targetPhone
        ? await queryOne('SELECT id FROM users WHERE phone = ? OR phone = ? LIMIT 1', [targetPhone, targetPhone])
        : await queryOne('SELECT id FROM users WHERE email = ? LIMIT 1', [targetEmail])
      await revokeBridgeRefreshSessions(resetUser?.id)
      await queryRun('UPDATE verification_codes SET used = 1, token_used = 1 WHERE id = ?', [tokenRecord.id])
      return res.json({ ok: true, message: '密码已重置' })
    }

    if (!code) return res.json({ ok: false, error: '请输入验证码' })

    const record = targetPhone
      ? await queryOne(`
          SELECT * FROM verification_codes
          WHERE (phone = ? OR phone = ?) AND code = ? AND purpose = 'reset' AND used = 0 AND expires_at > NOW()
          ORDER BY created_at DESC LIMIT 1
        `, [targetPhone, targetPhone, code])
      : await queryOne(`
          SELECT * FROM verification_codes
          WHERE email = ? AND code = ? AND purpose = 'reset' AND used = 0 AND expires_at > NOW()
          ORDER BY created_at DESC LIMIT 1
        `, [targetEmail, code])

    if (!record) return res.json({ ok: false, error: '验证码无效或已过期' })

    const hash = await bcrypt.hash(newPassword, 10)
    if (targetPhone) {
      await queryRun("UPDATE users SET password = ?, updated_at = NOW() WHERE phone = ? OR phone = ?", [hash, targetPhone, targetPhone])
    } else {
      await queryRun("UPDATE users SET password = ?, updated_at = NOW() WHERE email = ?", [hash, targetEmail])
    }
    const resetUser = targetPhone
      ? await queryOne('SELECT id FROM users WHERE phone = ? OR phone = ? LIMIT 1', [targetPhone, targetPhone])
      : await queryOne('SELECT id FROM users WHERE email = ? LIMIT 1', [targetEmail])
    await revokeBridgeRefreshSessions(resetUser?.id)
    await queryRun('UPDATE verification_codes SET used = 1 WHERE id = ?', [record.id])

    res.json({ ok: true, message: '密码已重置' })
  } catch (err) {
    console.error('[reset-password]', err.message)
    res.json({ ok: false, error: '重置密码失败' })
  }
})

router.post('/change-password', authMiddleware, async (req, res) => {
  try {
    const { oldPassword, newPassword, verifyToken } = req.body
    if (!newPassword) return res.json({ ok: false, error: '参数不完整' })

    const user = await queryOne('SELECT password FROM users WHERE id = ?', [req.user.id])

    if (oldPassword) {
      if (!await bcrypt.compare(oldPassword, user.password)) return res.json({ ok: false, error: '原密码错误' })
    } else if (!verifyToken) {
      return res.json({ ok: false, error: '请提供原密码或验证码' })
    } else {
      const tokenRecord = await queryOne(
        'SELECT id FROM verification_codes WHERE (email = ? OR phone = ?) AND verify_token = ? AND purpose IN (?, ?) AND expires_at > NOW() AND token_used = 0',
        [req.user.email, req.user.phone, verifyToken, 'change', 'change_password']
      )
      if (!tokenRecord) return res.json({ ok: false, error: '验证已过期，请重新验证' })
      await queryRun('UPDATE verification_codes SET token_used = 1 WHERE id = ?', [tokenRecord.id])
    }

    const hash = await bcrypt.hash(newPassword, 10)
    await queryRun("UPDATE users SET password = ?, updated_at = NOW() WHERE id = ?", [hash, req.user.id])
    await revokeBridgeRefreshSessions(req.user.id)

    res.json({ ok: true, relogin: true, message: '密码已修改' })
  } catch (err) {
    console.error('[change-password]', err.message)
    res.json({ ok: false, error: '修改密码失败' })
  }
})

router.post('/change-email', authMiddleware, async (req, res) => {
  try {
    const { oldPassword, newEmail, verifyToken } = req.body
    if (!newEmail || !verifyToken) return res.json({ ok: false, error: '参数不完整' })

    const user = await queryOne('SELECT password, email FROM users WHERE id = ?', [req.user.id])
    if (!oldPassword || !await bcrypt.compare(oldPassword, user.password)) {
      return res.json({ ok: false, error: '原密码错误' })
    }

    const existing = await queryOne('SELECT id FROM users WHERE email = ? AND id != ?', [newEmail, req.user.id])
    if (existing) return res.json({ ok: false, error: '该邮箱已被其他账号使用' })

    const tokenRecord = await queryOne(
      'SELECT id FROM verification_codes WHERE email = ? AND verify_token = ? AND purpose = ? AND expires_at > NOW() AND token_used = 0',
      [newEmail, verifyToken, 'change_email']
    )
    if (!tokenRecord) return res.json({ ok: false, error: '邮箱验证码无效或已过期' })

    await queryRun("UPDATE users SET email = ?, email_verified = 1, updated_at = NOW() WHERE id = ?", [newEmail, req.user.id])
    await queryRun('UPDATE verification_codes SET used = 1, token_used = 1 WHERE id = ?', [tokenRecord.id])

    res.json({ ok: true, message: '邮箱已更换' })
  } catch (err) {
    console.error('[change-email]', err.message)
    res.json({ ok: false, error: '更换邮箱失败' })
  }
})

router.post('/change-phone', authMiddleware, async (req, res) => {
  try {
    const { oldPassword, newPhone: rawNewPhone, verifyToken } = req.body
    const newPhone = normalizePhone(rawNewPhone)
    if (!newPhone || !verifyToken) return res.json({ ok: false, error: '参数不完整' })

    const user = await queryOne('SELECT password, phone FROM users WHERE id = ?', [req.user.id])
    if (!oldPassword || !await bcrypt.compare(oldPassword, user.password)) {
      return res.json({ ok: false, error: '原密码错误' })
    }

    const existing = await queryOne('SELECT id FROM users WHERE (phone = ? OR phone = ?) AND id != ?', [newPhone, newPhone, req.user.id])
    if (existing) return res.json({ ok: false, error: '该手机号已被其他账号使用' })

    const tokenRecord = await queryOne(
      'SELECT id FROM verification_codes WHERE (phone = ? OR phone = ?) AND verify_token = ? AND purpose = ? AND expires_at > NOW() AND token_used = 0',
      [newPhone, newPhone, verifyToken, 'change_phone']
    )
    if (!tokenRecord) return res.json({ ok: false, error: '手机验证码无效或已过期' })

    await queryRun("UPDATE users SET phone = ?, phone_verified = 1, updated_at = NOW() WHERE id = ?", [newPhone, req.user.id])
    await queryRun('UPDATE verification_codes SET used = 1, token_used = 1 WHERE id = ?', [tokenRecord.id])

    res.json({ ok: true, message: '手机号已更换' })
  } catch (err) {
    console.error('[change-phone]', err.message)
    res.json({ ok: false, error: '更换手机号失败' })
  }
})

router.post('/send-bind-code', authMiddleware, async (req, res) => {
  try {
    const { phone: rawPhone, email, captchaId, captchaAnswer } = req.body
    const phone = normalizePhone(rawPhone)
    if (!phone && !email) return res.json({ ok: false, error: '请输入手机号或邮箱' })

    // CAPTCHA verification (mandatory for phone)
    if (phone) {
      if (!captchaId || !captchaAnswer) return res.json({ ok: false, error: '请输入图形验证码' })
      const captchaOk = verifyCaptcha(captchaId, captchaAnswer)
      if (!captchaOk) return res.json({ ok: false, error: '图形验证码错误' })
    } else if (captchaId) {
      if (!captchaAnswer) return res.json({ ok: false, error: '请输入图形验证码' })
      const captchaOk = verifyCaptcha(captchaId, captchaAnswer)
      if (!captchaOk) return res.json({ ok: false, error: '图形验证码错误' })
    }

    if (phone) {
      const rateCheck = await checkSmsRateLimit(phone)
      if (!rateCheck.ok) return res.json({ ok: false, error: rateCheck.error })

      const existing = await queryOne('SELECT id FROM users WHERE (phone = ? OR phone = ?) AND id != ?', [phone, phone, req.user.id])
      if (existing) return res.json({ ok: false, error: '该手机号已被其他账号绑定' })

      try {
        await sendVerificationSms(phone, 'bind')
      } catch (smsErr) {
        console.error('[send-bind-code] SMS error:', smsErr.message)
        return res.json({ ok: false, error: '短信发送失败，请稍后重试' })
      }

      return res.json({ ok: true, message: '验证码已发送到您的手机' })
    }

    if (email) {
      const existing = await queryOne('SELECT id FROM users WHERE email = ? AND id != ?', [email, req.user.id])
      if (existing) return res.json({ ok: false, error: '该邮箱已被其他账号绑定' })

    const code = String(crypto.randomInt(100000, 999999))
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000 + 8 * 3600_000).toISOString().replace('T', ' ').substring(0, 19)
      await queryRun('INSERT INTO verification_codes (email, code, purpose, expires_at) VALUES (?, ?, ?, ?)', [email, code, 'bind', expiresAt])

      let emailSent = false
      try {
        emailSent = await sendSmtpEmail(email, '量见课堂 - 绑定验证码', `<p>您的绑定验证码是：<strong>${code}</strong>，10分钟内有效。</p>`)
      } catch (e) {
        console.error('[send-bind-code] Send email error:', e.message)
      }

      return res.json({ ok: true, message: emailSent ? '验证码已发送到您的邮箱' : '验证码已发送（本地开发模式请查看控制台）' })
    }
  } catch (err) {
    console.error('[send-bind-code]', err.message)
    res.json({ ok: false, error: '发送验证码失败' })
  }
})

router.post('/bind-phone', authMiddleware, async (req, res) => {
  try {
    const { phone: rawPhone, verifyToken } = req.body
    const phone = normalizePhone(rawPhone)
    if (!phone || !verifyToken) return res.json({ ok: false, error: '参数不完整' })

    const tokenRecord = await queryOne(
      'SELECT id FROM verification_codes WHERE (phone = ? OR phone = ?) AND verify_token = ? AND purpose = ? AND expires_at > NOW() AND token_used = 0',
      [phone, phone, verifyToken, 'bind']
    )
    if (!tokenRecord) return res.json({ ok: false, error: '验证已过期，请重新验证' })

    const existing = await queryOne('SELECT id FROM users WHERE (phone = ? OR phone = ?) AND id != ?', [phone, phone, req.user.id])
    if (existing) return res.json({ ok: false, error: '该手机号已被其他账号绑定' })

    await queryRun("UPDATE users SET phone = ?, phone_verified = 1, updated_at = NOW() WHERE id = ?", [phone, req.user.id])
    await queryRun('UPDATE verification_codes SET used = 1, token_used = 1 WHERE id = ?', [tokenRecord.id])

    res.json({ ok: true, message: '手机绑定成功' })
  } catch (err) {
    console.error('[bind-phone]', err.message)
    if (err.message?.includes('Duplicate')) {
      return res.json({ ok: false, error: '该手机号已被其他账号绑定' })
    }
    res.json({ ok: false, error: '绑定失败' })
  }
})

router.post('/bind-email', authMiddleware, async (req, res) => {
  try {
    const { email, verifyToken } = req.body
    if (!email || !verifyToken) return res.json({ ok: false, error: '参数不完整' })

    const tokenRecord = await queryOne(
      'SELECT id FROM verification_codes WHERE email = ? AND verify_token = ? AND purpose = ? AND expires_at > NOW() AND token_used = 0',
      [email, verifyToken, 'bind']
    )
    if (!tokenRecord) return res.json({ ok: false, error: '验证已过期，请重新验证' })

    const existing = await queryOne('SELECT id FROM users WHERE email = ? AND id != ?', [email, req.user.id])
    if (existing) return res.json({ ok: false, error: '该邮箱已被其他账号绑定' })

    await queryRun("UPDATE users SET email = ?, email_verified = 1, updated_at = NOW() WHERE id = ?", [email, req.user.id])
    await queryRun('UPDATE verification_codes SET used = 1, token_used = 1 WHERE id = ?', [tokenRecord.id])

    res.json({ ok: true, message: '邮箱绑定成功' })
  } catch (err) {
    console.error('[bind-email]', err.message)
    res.json({ ok: false, error: '绑定失败' })
  }
})

router.post('/telegram-entry', authMiddleware, async (req, res) => {
  try {
    const user = await queryOne('SELECT * FROM users WHERE id = ?', [req.user.id])

    const botUrl = `https://t.me/WallStreetSkillBot?start=${user.referral_code || user.id}`
    await queryRun("UPDATE users SET telegram_last_invite_sent_at = NOW(), updated_at = NOW() WHERE id = ?", [req.user.id])

    res.json({ ok: true, success: true, botUrl, expiresInSeconds: 600 })
  } catch (err) {
    console.error('[telegram-entry]', err.message)
    res.json({ ok: false, error: '生成失败' })
  }
})

export default router
