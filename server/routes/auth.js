import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { v4 as uuidv4 } from 'uuid'
import { queryOne, queryAll, queryRun, logAudit } from '../db.js'
import { generateToken, authMiddleware } from '../middleware/auth.js'
import nodemailer from 'nodemailer'

const router = Router()

function generateReferralCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 10; i++) {
    code += chars[Math.floor(Math.random() * chars.length)]
  }
  return code
}

router.post('/register', async (req, res) => {
  try {
    const { email, password, nickname, referral, referralCode } = req.body
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
      INSERT INTO users (email, password, nickname, referral_code, referred_by, uid, plan, plan_expires_at) VALUES (?, ?, ?, ?, ?, ?, 'pro', DATE_ADD(NOW(), INTERVAL 1 MONTH))
    `, [email, hash, nickname || email.split('@')[0], code, referredBy, 'WS' + String(Date.now()).slice(-6)])

    const token = generateToken(result.insertId)
    const user = await queryOne('SELECT id, uid, email, nickname, avatar, role, plan, plan_expires_at, referral_code, referral_credit FROM users WHERE id = ?', [result.insertId])
    user.name = user.nickname
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
    const { email, password, method, verifyToken } = req.body
    if (!email) return res.json({ ok: false, error: '请输入邮箱' })

    const user = await queryOne('SELECT * FROM users WHERE email = ?', [email])
    if (!user) return res.json({ ok: false, error: '邮箱或密码错误' })

    // Password login
    if (!method || method === 'password') {
      if (!password) return res.json({ ok: false, error: '请输入密码' })
      if (!await bcrypt.compare(password, user.password)) return res.json({ ok: false, error: '邮箱或密码错误' })
    }
    // Code login — verifyToken must match a server-issued token
    else if (method === 'code') {
      if (!verifyToken) return res.json({ ok: false, error: '请先完成邮箱验证' })
      const tokenRecord = await queryOne(
        'SELECT id FROM verification_codes WHERE email = ? AND verify_token = ? AND purpose = ? AND expires_at > NOW()',
        [email, verifyToken, 'login']
      )
      if (!tokenRecord) return res.json({ ok: false, error: '验证已过期，请重新验证' })
    }

    const token = generateToken(user.id)
    const { password: _, ...safeUser } = user
    safeUser.name = user.nickname
    safeUser.isAdmin = user.role === 'admin'
    safeUser.planExpiresAt = user.plan_expires_at || ''
    safeUser.planPeriod = user.plan_period || ''
    safeUser.createdAt = user.created_at || ''
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
    const { email, purpose } = req.body
    const targetEmail = email || req.user?.email
    if (!targetEmail) return res.json({ ok: false, error: '请输入邮箱' })

    // 注册前检查邮箱是否已注册
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
    console.error('[send-code]', err.message)
    res.json({ ok: false, error: '发送验证码失败' })
  }
})

router.post('/verify-code', async (req, res) => {
  try {
    const { email, code, purpose } = req.body
    const targetEmail = email || req.user?.email
    if (!targetEmail) return res.json({ ok: false, error: '请输入邮箱' })
    const record = await queryOne(`
      SELECT * FROM verification_codes
      WHERE email = ? AND code = ? AND purpose = ? AND used = 0 AND expires_at > NOW()
      ORDER BY created_at DESC LIMIT 1
    `, [targetEmail, code, purpose || 'login'])

    if (!record) return res.json({ ok: false, error: '验证码无效或已过期' })

    // Generate a temporary token for the verified email (store it server-side)
    const verifyToken = uuidv4()
    await queryRun('UPDATE verification_codes SET used = 1, verify_token = ? WHERE id = ?', [verifyToken, record.id])
    res.json({ ok: true, message: '验证成功', token: verifyToken })
  } catch (err) {
    res.json({ ok: false, error: '验证失败' })
  }
})

router.post('/reset-password', async (req, res) => {
  try {
    const { email, code, newPassword, verifyToken } = req.body
    if (!email || !newPassword) return res.json({ ok: false, error: '参数不完整' })

    // verifyToken flow: validate server-issued token
    if (verifyToken) {
      const tokenRecord = await queryOne(
        'SELECT id FROM verification_codes WHERE email = ? AND verify_token = ? AND purpose = ? AND expires_at > NOW()',
        [email, verifyToken, 'reset']
      )
      if (!tokenRecord) return res.json({ ok: false, error: '验证已过期，请重新验证' })

      const hash = await bcrypt.hash(newPassword, 10)
      await queryRun("UPDATE users SET password = ?, updated_at = NOW() WHERE email = ?", [hash, email])
      // 标记 verifyToken 已使用，防止重复利用
      await queryRun('UPDATE verification_codes SET used = 1 WHERE id = ?', [tokenRecord.id])
      return res.json({ ok: true, message: '密码已重置' })
    }

    if (!code) return res.json({ ok: false, error: '请输入验证码' })
    const record = await queryOne(`
      SELECT * FROM verification_codes
      WHERE email = ? AND code = ? AND purpose = 'reset' AND used = 0 AND expires_at > NOW()
      ORDER BY created_at DESC LIMIT 1
    `, [email, code])

    if (!record) return res.json({ ok: false, error: '验证码无效或已过期' })

    const hash = await bcrypt.hash(newPassword, 10)
    await queryRun("UPDATE users SET password = ?, updated_at = NOW() WHERE email = ?", [hash, email])
    await queryRun('UPDATE verification_codes SET used = 1 WHERE id = ?', [record.id])

    res.json({ ok: true, message: '密码已重置' })
  } catch (err) {
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
      // Validate server-issued verifyToken
      const tokenRecord = await queryOne(
        'SELECT id FROM verification_codes WHERE email = ? AND verify_token = ? AND purpose = ? AND expires_at > NOW()',
        [req.user.email, verifyToken, 'change']
      )
      if (!tokenRecord) return res.json({ ok: false, error: '验证已过期，请重新验证' })
    }

    const hash = await bcrypt.hash(newPassword, 10)
    await queryRun("UPDATE users SET password = ?, updated_at = NOW() WHERE id = ?", [hash, req.user.id])

    res.json({ ok: true, relogin: true, message: '密码已修改' })
  } catch (err) {
    res.json({ ok: false, error: '修改密码失败' })
  }
})

router.post('/telegram-entry', authMiddleware, async (req, res) => {
  try {
    const user = await queryOne('SELECT * FROM users WHERE id = ?', [req.user.id])

    // Generate a fake bot URL for local dev
    const botUrl = `https://t.me/WallStreetSkillBot?start=${user.referral_code || user.id}`
    await queryRun("UPDATE users SET telegram_last_invite_sent_at = NOW(), updated_at = NOW() WHERE id = ?", [req.user.id])

    res.json({ ok: true, success: true, botUrl, expiresInSeconds: 600 })
  } catch (err) {
    res.json({ ok: false, error: '生成失败' })
  }
})

export default router
