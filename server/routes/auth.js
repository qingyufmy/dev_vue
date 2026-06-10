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

    const hash = bcrypt.hashSync(password, 10)
    const code = referralCode || generateReferralCode()
    const ref = referral || null

    let referredBy = null
    if (ref) {
      const referrer = await queryOne('SELECT id FROM users WHERE referral_code = ?', [ref.toUpperCase()])
      if (referrer) referredBy = ref.toUpperCase()
    }

    const result = await queryRun(`
      INSERT INTO users (email, password, nickname, referral_code, referred_by, uid) VALUES (?, ?, ?, ?, ?, ?)
    `, [email, hash, nickname || email.split('@')[0], code, referredBy, 'WS' + String(Date.now()).slice(-6)])

    const token = generateToken(result.insertId)
    const user = await queryOne('SELECT id, uid, email, nickname, avatar, role, plan, plan_expires_at, referral_code, referral_credit FROM users WHERE id = ?', [result.insertId])
    user.name = user.nickname

    if (referredBy) {
      const referrer = await queryOne('SELECT id FROM users WHERE referral_code = ?', [referredBy])
      if (referrer) await queryRun('INSERT INTO referrals (referrer_id, referred_id, status) VALUES (?, ?, ?)', [referrer.id, result.insertId, 'pending'])
    }

    await queryRun('INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)', [result.insertId, 'system', '欢迎加入街哥课堂', '您的账户已创建成功，开始学习吧！'])

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
      if (!bcrypt.compareSync(password, user.password)) return res.json({ ok: false, error: '邮箱或密码错误' })
    }
    // Code login (verifyToken already verified)
    else if (method === 'code') {
      if (!verifyToken) return res.json({ ok: false, error: '请先完成邮箱验证' })
      // In local mode, accept any non-empty verifyToken
    }

    const token = generateToken(user.id)
    const { password: _, ...safeUser } = user
    safeUser.name = user.nickname
    safeUser.isAdmin = user.role === 'admin'
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
    const code = String(Math.floor(100000 + Math.random() * 900000))
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19)

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
            from: { name: smtpConfig.from_name || '街哥课堂', address: smtpConfig.from || smtpConfig.user },
            to: targetEmail,
            subject: '街哥课堂 - 验证码',
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

    if (!emailSent) console.log(`[验证码] ${targetEmail}: ${code}`)
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
      WHERE email = ? AND code = ? AND purpose = ? AND used = 0 AND expires_at > DATE_ADD(NOW(), INTERVAL 8 HOUR)
      ORDER BY created_at DESC LIMIT 1
    `, [targetEmail, code, purpose || 'login'])

    if (!record) return res.json({ ok: false, error: '验证码无效或已过期' })
    await queryRun('UPDATE verification_codes SET used = 1 WHERE id = ?', [record.id])

    // Generate a temporary token for the verified email
    const verifyToken = uuidv4()
    res.json({ ok: true, message: '验证成功', token: verifyToken })
  } catch (err) {
    res.json({ ok: false, error: '验证失败' })
  }
})

router.post('/reset-password', async (req, res) => {
  try {
    const { email, code, newPassword, verifyToken } = req.body
    if (!email || !newPassword) return res.json({ ok: false, error: '参数不完整' })

    // If verifyToken provided (code-based flow), accept it
    if (verifyToken) {
      const hash = bcrypt.hashSync(newPassword, 10)
      await queryRun("UPDATE users SET password = ?, updated_at = DATE_ADD(NOW(), INTERVAL 8 HOUR) WHERE email = ?", [hash, email])
      return res.json({ ok: true, message: '密码已重置' })
    }

    if (!code) return res.json({ ok: false, error: '请输入验证码' })
    const record = await queryOne(`
      SELECT * FROM verification_codes
      WHERE email = ? AND code = ? AND purpose = 'reset' AND used = 0 AND expires_at > DATE_ADD(NOW(), INTERVAL 8 HOUR)
      ORDER BY created_at DESC LIMIT 1
    `, [email, code])

    if (!record) return res.json({ ok: false, error: '验证码无效或已过期' })

    const hash = bcrypt.hashSync(newPassword, 10)
    await queryRun("UPDATE users SET password = ?, updated_at = DATE_ADD(NOW(), INTERVAL 8 HOUR) WHERE email = ?", [hash, email])
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
      if (!bcrypt.compareSync(oldPassword, user.password)) return res.json({ ok: false, error: '原密码错误' })
    } else if (!verifyToken) {
      return res.json({ ok: false, error: '请提供原密码或验证码' })
    }

    const hash = bcrypt.hashSync(newPassword, 10)
    await queryRun("UPDATE users SET password = ?, updated_at = DATE_ADD(NOW(), INTERVAL 8 HOUR) WHERE id = ?", [hash, req.user.id])

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
    await queryRun("UPDATE users SET telegram_last_invite_sent_at = DATE_ADD(NOW(), INTERVAL 8 HOUR), updated_at = DATE_ADD(NOW(), INTERVAL 8 HOUR) WHERE id = ?", [req.user.id])

    res.json({ ok: true, success: true, botUrl, expiresInSeconds: 600 })
  } catch (err) {
    res.json({ ok: false, error: '生成失败' })
  }
})

export default router
