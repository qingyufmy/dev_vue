import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { v4 as uuidv4 } from 'uuid'
import { queryOne, queryAll, queryRun, logAudit } from '../db.js'
import { generateToken, authMiddleware } from '../middleware/auth.js'
import nodemailer from 'nodemailer'
import { sendVerificationSms } from '../sms.js'
import { generateCaptcha, verifyCaptcha } from '../captcha.js'

const router = Router()

async function checkSmsRateLimit(phone) {
  const dbPhone = phone.replace(/^\+86/, '')
  const rows = await queryAll(
    `SELECT created_at FROM verification_codes
     WHERE (phone = ? OR phone = ?) AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)
     ORDER BY created_at DESC`,
    [dbPhone, phone]
  )

  const recent = rows.filter(r => {
    const diff = Date.now() - new Date(r.created_at).getTime()
    return diff < 2 * 60 * 1000
  })
  if (recent.length > 0) return { ok: false, error: '发送过于频繁，请2分钟后再试' }

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
    code += chars[Math.floor(Math.random() * chars.length)]
  }
  return code
}

router.get('/auth-methods', async (req, res) => {
  try {
    const rows = await queryAll("SELECT `key`, `value` FROM system_config WHERE category = 'auth_toggle'")
    const toggleMap = {}
    for (const r of rows) toggleMap[r.key] = r.value
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
    const { email, phone, password, nickname, referral, referralCode, verifyToken, authMethod } = req.body
    const method = authMethod || (phone ? 'phone' : 'email')

    // Check auth toggles
    try {
      const rows = await queryAll("SELECT `key`, `value` FROM system_config WHERE category = 'auth_toggle'")
      const toggleMap = {}
      for (const r of rows) toggleMap[r.key] = r.value
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
      if (password.length < 6) return res.json({ ok: false, error: '密码至少6位' })
      if (!verifyToken) return res.json({ ok: false, error: '请先完成手机验证' })

      const tokenRecord = await queryOne(
        'SELECT id FROM verification_codes WHERE (phone = ? OR phone = ?) AND verify_token = ? AND purpose = ? AND expires_at > NOW()',
        [phone.replace(/^\+86/, ''), phone, verifyToken, 'register']
      )
      if (!tokenRecord) return res.json({ ok: false, error: '手机验证已过期，请重新验证' })

      const existing = await queryOne('SELECT id FROM users WHERE phone = ?', [phone])
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
        INSERT INTO users (phone, password, nickname, referral_code, referred_by, uid, plan, plan_expires_at, auth_method, phone_verified)
        VALUES (?, ?, ?, ?, ?, ?, 'pro', DATE_ADD(NOW(), INTERVAL 1 MONTH), 'phone', 1)
      `, [phone, hash, nickname || '手机用户', code, referredBy, 'WS' + String(Date.now()).slice(-6)])

      const token = generateToken(result.insertId)
      const user = await queryOne('SELECT id, uid, phone, nickname, avatar, role, plan, plan_expires_at, referral_code, referral_credit FROM users WHERE id = ?', [result.insertId])
      user.name = user.nickname
      user.authMethod = 'phone'
      user.planExpiresAt = user.plan_expires_at || ''

      if (referredBy) {
        const referrer = await queryOne('SELECT id FROM users WHERE referral_code = ?', [referredBy])
        if (referrer) await queryRun('INSERT INTO referrals (referrer_id, referred_id, status) VALUES (?, ?, ?)', [referrer.id, result.insertId, 'pending'])
      }

      await queryRun('UPDATE verification_codes SET used = 1 WHERE id = ?', [tokenRecord.id])
      await queryRun('INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)', [result.insertId, 'system', '欢迎加入量见课堂', '您的账户已创建成功，开始学习吧！'])
      await queryRun('INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)', [result.insertId, 'system', '🎁 新会员福利', '已为您赠送 1 个月 Pro 会员体验，尽享全部课程和 AI 全自动交易！'])

      logAudit({ userId: result.insertId, action: 'register', ip: req.ip, userAgent: req.get('user-agent') })
      return res.json({ ok: true, token, user })
    }

    // Email registration (original logic)
    if (!email || !password) return res.json({ ok: false, error: '邮箱和密码不能为空' })
    if (password.length < 6) return res.json({ ok: false, error: '密码至少6位' })

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
      INSERT INTO users (email, password, nickname, referral_code, referred_by, uid, plan, plan_expires_at, auth_method, email_verified)
      VALUES (?, ?, ?, ?, ?, ?, 'pro', DATE_ADD(NOW(), INTERVAL 1 MONTH), 'email', 1)
    `, [email, hash, nickname || email.split('@')[0], code, referredBy, 'WS' + String(Date.now()).slice(-6)])

    const token = generateToken(result.insertId)
    const user = await queryOne('SELECT id, uid, email, nickname, avatar, role, plan, plan_expires_at, referral_code, referral_credit FROM users WHERE id = ?', [result.insertId])
    user.name = user.nickname
    user.authMethod = 'email'
    user.planExpiresAt = user.plan_expires_at || ''

    if (referredBy) {
      const referrer = await queryOne('SELECT id FROM users WHERE referral_code = ?', [referredBy])
      if (referrer) await queryRun('INSERT INTO referrals (referrer_id, referred_id, status) VALUES (?, ?, ?)', [referrer.id, result.insertId, 'pending'])
    }

    await queryRun('INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)', [result.insertId, 'system', '欢迎加入量见课堂', '您的账户已创建成功，开始学习吧！'])
    await queryRun('INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)', [result.insertId, 'system', '🎁 新会员福利', '已为您赠送 1 个月 Pro 会员体验，尽享全部课程和 AI 全自动交易！'])

    logAudit({ userId: result.insertId, action: 'register', ip: req.ip, userAgent: req.get('user-agent') })

    res.json({ ok: true, token, user })
  } catch (err) {
    console.error('Register error:', err)
    res.json({ ok: false, error: '注册失败，请稍后重试' })
  }
})

router.post('/login', async (req, res) => {
  try {
    const { email, phone, password, method, verifyToken } = req.body
    const loginId = phone || email
    if (!loginId) return res.json({ ok: false, error: '请输入邮箱或手机号' })

    // Check auth toggles
    try {
      const rows = await queryAll("SELECT `key`, `value` FROM system_config WHERE category = 'auth_toggle'")
      const toggleMap = {}
      for (const r of rows) toggleMap[r.key] = r.value
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
      ? await queryOne('SELECT * FROM users WHERE phone = ? OR phone = ?', [phone.replace(/^\+86/, ''), phone])
      : await queryOne('SELECT * FROM users WHERE email = ?', [email])
    if (!user) return res.json({ ok: false, error: '账号或密码错误' })

    // Password login
    if (!method || method === 'password') {
      if (!password) return res.json({ ok: false, error: '请输入密码' })
      if (!await bcrypt.compare(password, user.password)) return res.json({ ok: false, error: '账号或密码错误' })
    }
    // Code login — verifyToken must match a server-issued token
    else if (method === 'code') {
      if (!verifyToken) return res.json({ ok: false, error: '请先完成验证' })
      const tokenRecord = phone
        ? await queryOne(
            'SELECT id FROM verification_codes WHERE (phone = ? OR phone = ?) AND verify_token = ? AND purpose = ? AND expires_at > NOW()',
            [phone.replace(/^\+86/, ''), phone, verifyToken, 'login']
          )
        : await queryOne(
            'SELECT id FROM verification_codes WHERE email = ? AND verify_token = ? AND purpose = ? AND expires_at > NOW()',
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
    safeUser.createdAt = user.created_at || ''
    safeUser.authMethod = user.auth_method || 'email'
    safeUser.telegramBinding = getTelegramBinding(user)

    logAudit({ userId: user.id, action: 'login', ip: req.ip, userAgent: req.get('user-agent') })

    res.json({ ok: true, token, user: safeUser })
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
    const { email, phone, purpose, captchaId, captchaAnswer } = req.body
    const targetEmail = email || req.user?.email
    const targetPhone = phone
    if (!targetEmail && !targetPhone) return res.json({ ok: false, error: '请输入邮箱或手机号' })

    // Check auth toggles
    try {
      const rows = await queryAll("SELECT `key`, `value` FROM system_config WHERE category = 'auth_toggle'")
      const toggleMap = {}
      for (const r of rows) toggleMap[r.key] = r.value
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
    const normalizePhone = (p) => p ? p.replace(/^\+86/, '') : p
    const dbPhone = normalizePhone(targetPhone)
    if (dbPhone && purpose === 'register') {
      const existing = await queryOne('SELECT id FROM users WHERE phone = ? OR phone = ?', [dbPhone, targetPhone])
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

      let smsSent = false
      try {
        await sendVerificationSms(targetPhone, purpose || 'login')
        smsSent = true
      } catch (smsErr) {
        console.error('[send-code] SMS error:', smsErr.message)
      }

      return res.json({ ok: true, message: smsSent ? '验证码已发送到您的手机' : '验证码已发送（本地开发模式请查看控制台）' })
    }

    // Email flow (original)
    if (purpose === 'register') {
      const existing = await queryOne('SELECT id FROM users WHERE email = ?', [targetEmail])
      if (existing) return res.json({ ok: false, error: '该邮箱已注册' })
    }

    const code = String(Math.floor(100000 + Math.random() * 900000))
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000 + 8 * 3600_000).toISOString().replace('T', ' ').substring(0, 19)

    await queryRun('INSERT INTO verification_codes (email, code, purpose, expires_at) VALUES (?, ?, ?, ?)', [targetEmail, code, purpose || 'login', expiresAt])

    // Try to send email via SMTP config
    let emailSent = false
    try {
      const smtpConfig = {}
      const rows = await queryAll("SELECT `key`, `value` FROM system_config WHERE category = 'smtp'")
      for (const r of rows) smtpConfig[r.key] = r.value

      if (smtpConfig.host && smtpConfig.user) {
        try {
          const transporter = nodemailer.createTransport({
            host: smtpConfig.host,
            port: Number(smtpConfig.port) || 587,
            secure: smtpConfig.secure === 'true',
            auth: { user: smtpConfig.user, pass: smtpConfig.pass },
          })
          await transporter.sendMail({
            from: { name: smtpConfig.from_name || '量见课堂', address: smtpConfig.from || smtpConfig.user },
            to: targetEmail,
            subject: '量见课堂 - 验证码',
            html: `<p>您的验证码是：<strong>${code}</strong>，10分钟内有效。</p>`,
          })
          emailSent = true
        } catch (e) {
          console.error('Nodemailer error:', e.message)
        }
      }
    } catch (emailErr) {
      console.error('Send email error:', emailErr.message)
    }

    res.json({ ok: true, message: emailSent ? '验证码已发送到您的邮箱' : '验证码已发送（本地开发模式请查看控制台）' })
  } catch (err) {
    console.error('[send-code] FATAL:', err.message, err.stack)
    res.json({ ok: false, error: '发送验证码失败' })
  }
})

router.post('/verify-code', async (req, res) => {
  try {
    const { email, phone, code, purpose } = req.body
    const targetEmail = email || req.user?.email
    const targetPhone = phone

    if (!targetEmail && !targetPhone) return res.json({ ok: false, error: '请输入邮箱或手机号' })

    const record = targetPhone
      ? await queryOne(`
          SELECT * FROM verification_codes
          WHERE (phone = ? OR phone = ?) AND code = ? AND purpose = ? AND used = 0 AND expires_at > NOW()
          ORDER BY created_at DESC LIMIT 1
        `, [targetPhone.replace(/^\+86/, ''), targetPhone, code, purpose || 'login'])
      : await queryOne(`
          SELECT * FROM verification_codes
          WHERE email = ? AND code = ? AND purpose = ? AND used = 0 AND expires_at > NOW()
          ORDER BY created_at DESC LIMIT 1
        `, [targetEmail, code, purpose || 'login'])

    if (!record) return res.json({ ok: false, error: '验证码无效或已过期' })

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
    const { email, phone, code, newPassword, verifyToken } = req.body
    const targetEmail = email
    const targetPhone = phone
    if ((!targetEmail && !targetPhone) || !newPassword) return res.json({ ok: false, error: '参数不完整' })

    // verifyToken flow
    if (verifyToken) {
      const tokenRecord = targetPhone
        ? await queryOne(
            'SELECT id FROM verification_codes WHERE (phone = ? OR phone = ?) AND verify_token = ? AND purpose = ? AND expires_at > NOW()',
            [targetPhone.replace(/^\+86/, ''), targetPhone, verifyToken, 'reset']
          )
        : await queryOne(
            'SELECT id FROM verification_codes WHERE email = ? AND verify_token = ? AND purpose = ? AND expires_at > NOW()',
            [targetEmail, verifyToken, 'reset']
          )
      if (!tokenRecord) return res.json({ ok: false, error: '验证已过期，请重新验证' })

      const hash = await bcrypt.hash(newPassword, 10)
      if (targetPhone) {
        await queryRun("UPDATE users SET password = ?, updated_at = NOW() WHERE phone = ? OR phone = ?", [hash, targetPhone.replace(/^\+86/, ''), targetPhone])
      } else {
        await queryRun("UPDATE users SET password = ?, updated_at = NOW() WHERE email = ?", [hash, targetEmail])
      }
      await queryRun('UPDATE verification_codes SET used = 1 WHERE id = ?', [tokenRecord.id])
      return res.json({ ok: true, message: '密码已重置' })
    }

    if (!code) return res.json({ ok: false, error: '请输入验证码' })

    const record = targetPhone
      ? await queryOne(`
          SELECT * FROM verification_codes
          WHERE (phone = ? OR phone = ?) AND code = ? AND purpose = 'reset' AND used = 0 AND expires_at > NOW()
          ORDER BY created_at DESC LIMIT 1
        `, [targetPhone.replace(/^\+86/, ''), targetPhone, code])
      : await queryOne(`
          SELECT * FROM verification_codes
          WHERE email = ? AND code = ? AND purpose = 'reset' AND used = 0 AND expires_at > NOW()
          ORDER BY created_at DESC LIMIT 1
        `, [targetEmail, code])

    if (!record) return res.json({ ok: false, error: '验证码无效或已过期' })

    const hash = await bcrypt.hash(newPassword, 10)
    if (targetPhone) {
      await queryRun("UPDATE users SET password = ?, updated_at = NOW() WHERE phone = ? OR phone = ?", [hash, targetPhone.replace(/^\+86/, ''), targetPhone])
    } else {
      await queryRun("UPDATE users SET password = ?, updated_at = NOW() WHERE email = ?", [hash, targetEmail])
    }
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
        'SELECT id FROM verification_codes WHERE (email = ? OR phone = ?) AND verify_token = ? AND purpose = ? AND expires_at > NOW()',
        [req.user.email, req.user.phone, verifyToken, 'change']
      )
      if (!tokenRecord) return res.json({ ok: false, error: '验证已过期，请重新验证' })
    }

    const hash = await bcrypt.hash(newPassword, 10)
    await queryRun("UPDATE users SET password = ?, updated_at = NOW() WHERE id = ?", [hash, req.user.id])

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
      'SELECT id FROM verification_codes WHERE email = ? AND verify_token = ? AND purpose = ? AND expires_at > NOW()',
      [newEmail, verifyToken, 'change_email']
    )
    if (!tokenRecord) return res.json({ ok: false, error: '邮箱验证码无效或已过期' })

    await queryRun("UPDATE users SET email = ?, email_verified = 1, updated_at = NOW() WHERE id = ?", [newEmail, req.user.id])
    await queryRun('UPDATE verification_codes SET used = 1 WHERE id = ?', [tokenRecord.id])

    res.json({ ok: true, message: '邮箱已更换' })
  } catch (err) {
    console.error('[change-email]', err.message)
    res.json({ ok: false, error: '更换邮箱失败' })
  }
})

router.post('/change-phone', authMiddleware, async (req, res) => {
  try {
    const { oldPassword, newPhone, verifyToken } = req.body
    if (!newPhone || !verifyToken) return res.json({ ok: false, error: '参数不完整' })

    const user = await queryOne('SELECT password, phone FROM users WHERE id = ?', [req.user.id])
    if (!oldPassword || !await bcrypt.compare(oldPassword, user.password)) {
      return res.json({ ok: false, error: '原密码错误' })
    }

    const dbPhone = newPhone.replace(/^\+86/, '')
    const existing = await queryOne('SELECT id FROM users WHERE (phone = ? OR phone = ?) AND id != ?', [dbPhone, newPhone, req.user.id])
    if (existing) return res.json({ ok: false, error: '该手机号已被其他账号使用' })

    const tokenRecord = await queryOne(
      'SELECT id FROM verification_codes WHERE (phone = ? OR phone = ?) AND verify_token = ? AND purpose = ? AND expires_at > NOW()',
      [dbPhone, newPhone, verifyToken, 'change_phone']
    )
    if (!tokenRecord) return res.json({ ok: false, error: '手机验证码无效或已过期' })

    await queryRun("UPDATE users SET phone = ?, phone_verified = 1, updated_at = NOW() WHERE id = ?", [dbPhone, req.user.id])
    await queryRun('UPDATE verification_codes SET used = 1 WHERE id = ?', [tokenRecord.id])

    res.json({ ok: true, message: '手机号已更换' })
  } catch (err) {
    console.error('[change-phone]', err.message)
    res.json({ ok: false, error: '更换手机号失败' })
  }
})

router.post('/send-bind-code', authMiddleware, async (req, res) => {
  try {
    const { phone, email, captchaId, captchaAnswer } = req.body
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
      const dbPhone = phone.replace(/^\+86/, '')
      const rateCheck = await checkSmsRateLimit(phone)
      if (!rateCheck.ok) return res.json({ ok: false, error: rateCheck.error })

      const existing = await queryOne('SELECT id FROM users WHERE (phone = ? OR phone = ?) AND id != ?', [dbPhone, phone, req.user.id])
      if (existing) return res.json({ ok: false, error: '该手机号已被其他账号绑定' })

      let smsSent = false
      try {
        await sendVerificationSms(phone, 'bind')
        smsSent = true
      } catch (smsErr) {
        console.error('[send-bind-code] SMS error:', smsErr.message)
      }

      return res.json({ ok: true, message: smsSent ? '验证码已发送到您的手机' : '验证码已发送（本地开发模式请查看控制台）' })
    }

    if (email) {
      const existing = await queryOne('SELECT id FROM users WHERE email = ? AND id != ?', [email, req.user.id])
      if (existing) return res.json({ ok: false, error: '该邮箱已被其他账号绑定' })

      const code = String(Math.floor(100000 + Math.random() * 900000))
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000 + 8 * 3600_000).toISOString().replace('T', ' ').substring(0, 19)
      await queryRun('INSERT INTO verification_codes (email, code, purpose, expires_at) VALUES (?, ?, ?, ?)', [email, code, 'bind', expiresAt])

      let emailSent = false
      try {
        const smtpConfig = {}
        const rows = await queryAll("SELECT `key`, `value` FROM system_config WHERE category = 'smtp'")
        for (const r of rows) smtpConfig[r.key] = r.value

        if (smtpConfig.host && smtpConfig.user) {
          try {
            const transporter = nodemailer.createTransport({
              host: smtpConfig.host,
              port: Number(smtpConfig.port) || 587,
              secure: smtpConfig.secure === 'true',
              auth: { user: smtpConfig.user, pass: smtpConfig.pass },
            })
            await transporter.sendMail({
              from: { name: smtpConfig.from_name || '量见课堂', address: smtpConfig.from || smtpConfig.user },
              to: email,
              subject: '量见课堂 - 绑定验证码',
              html: `<p>您的绑定验证码是：<strong>${code}</strong>，10分钟内有效。</p>`,
            })
            emailSent = true
          } catch (e) {
            console.error('[send-bind-code] Nodemailer error:', e.message)
          }
        }
      } catch (emailErr) {
        console.error('[send-bind-code] email error:', emailErr.message)
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
    const { phone, verifyToken } = req.body
    if (!phone || !verifyToken) return res.json({ ok: false, error: '参数不完整' })

    const tokenRecord = await queryOne(
      'SELECT id FROM verification_codes WHERE (phone = ? OR phone = ?) AND verify_token = ? AND purpose = ? AND expires_at > NOW()',
      [phone.replace(/^\+86/, ''), phone, verifyToken, 'bind']
    )
    if (!tokenRecord) return res.json({ ok: false, error: '验证已过期，请重新验证' })

    const existing = await queryOne('SELECT id FROM users WHERE (phone = ? OR phone = ?) AND id != ?', [phone.replace(/^\+86/, ''), phone, req.user.id])
    if (existing) return res.json({ ok: false, error: '该手机号已被其他账号绑定' })

    await queryRun("UPDATE users SET phone = ?, phone_verified = 1, updated_at = NOW() WHERE id = ?", [phone.replace(/^\+86/, ''), req.user.id])
    await queryRun('UPDATE verification_codes SET used = 1 WHERE id = ?', [tokenRecord.id])

    res.json({ ok: true, message: '手机绑定成功' })
  } catch (err) {
    console.error('[bind-phone]', err.message)
    res.json({ ok: false, error: '绑定失败' })
  }
})

router.post('/bind-email', authMiddleware, async (req, res) => {
  try {
    const { email, verifyToken } = req.body
    if (!email || !verifyToken) return res.json({ ok: false, error: '参数不完整' })

    const tokenRecord = await queryOne(
      'SELECT id FROM verification_codes WHERE email = ? AND verify_token = ? AND purpose = ? AND expires_at > NOW()',
      [email, verifyToken, 'bind']
    )
    if (!tokenRecord) return res.json({ ok: false, error: '验证已过期，请重新验证' })

    const existing = await queryOne('SELECT id FROM users WHERE email = ? AND id != ?', [email, req.user.id])
    if (existing) return res.json({ ok: false, error: '该邮箱已被其他账号绑定' })

    await queryRun("UPDATE users SET email = ?, email_verified = 1, updated_at = NOW() WHERE id = ?", [email, req.user.id])
    await queryRun('UPDATE verification_codes SET used = 1 WHERE id = ?', [tokenRecord.id])

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
