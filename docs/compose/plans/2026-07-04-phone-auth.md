# 手机号登录注册系统 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use compose:subagent (recommended) or compose:execute to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add phone number login/registration/binding to the AURUM platform using Alibaba Cloud SMS, with admin-configurable toggles and self-built CAPTCHA.

**Architecture:** Extend existing email-based auth system with parallel phone-based flows. Database adds `phone` column to `users` and `phone` column to `verification_codes`. Backend adds `sms.js` (Alibaba Cloud SMS) and `captcha.js` (SVG CAPTCHA). Frontend adds phone auth modes to existing auth modal. Admin panel adds SMS config tab and auth toggle tab.

**Tech Stack:** Node.js ESM, Express, MySQL (mysql2/promise), `@alicloud/dysmsapi20170525` (SMS SDK), `svg-captcha` (CAPTCHA), vanilla HTML/CSS/JS frontend.

## Global Constraints

- ESM only (`"type": "module"` in package.json), use `import/export`
- All timestamps use `beijingNow()` from `server/db.js`
- Parameterized SQL queries only (`?` placeholders), never string concatenation
- Auth: use `authMiddleware` from `middleware/auth.js`, never inline role checks
- UI text and comments in Chinese
- `npm run dev` must start without `[FATAL]` errors
- Never modify auto-reasoning, bridge scheduling, trade execution, or observation mode logic

---

### Task 1: Database Migration — Users Table Extension

**Covers:** [S2]

**Files:**
- Modify: `server/migrations.js`

**Interfaces:**
- Produces: Migration `021_add_phone_auth` that adds `phone`, `phone_verified`, `email_verified`, `auth_method` columns to `users` table and `phone` column to `verification_codes` table

- [ ] **Step 1: Add migration to migrations.js**

Add after the last migration (id `020` or whatever the latest is):

```javascript
{
  id: '021_add_phone_auth',
  up: async () => {
    const addCol = async (table, col, def) => {
      try {
        const cols = await queryAll(`SHOW COLUMNS FROM ${table} LIKE '${col}'`)
        if (!cols || !cols.length) {
          await queryRun(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`)
        }
      } catch (e) {
        if (!e.message?.includes('Duplicate')) console.error(`[Migrations] 021 ${table}.${col}:`, e.message)
      }
    }
    await addCol('users', 'phone', "VARCHAR(20) UNIQUE DEFAULT NULL AFTER email")
    await addCol('users', 'phone_verified', "TINYINT DEFAULT 0 AFTER phone")
    await addCol('users', 'email_verified', "TINYINT DEFAULT 1 AFTER email")
    await addCol('users', 'auth_method', "VARCHAR(20) DEFAULT 'email' AFTER email_verified")
    await addCol('verification_codes', 'phone', "VARCHAR(20) DEFAULT NULL AFTER email")
  }
}
```

- [ ] **Step 2: Verify migration runs**

Run: `npm run dev`
Expected: Server starts, console shows `[Migrations] Applied: 021_add_phone_auth` (first time) or `Already exists, marked: 021_add_phone_auth` (subsequent)

- [ ] **Step 3: Commit**

```bash
git add server/migrations.js
git commit -m "feat(auth): add phone auth migration (users phone, verification_codes phone)"
```

---

### Task 2: Database Seed — SMS Config and Auth Toggles

**Covers:** [S2]

**Files:**
- Modify: `server/db.js` (in `initDB()`, after existing `sysConfigs` seed)

**Interfaces:**
- Produces: `system_config` rows with `category='sms'` and `category='auth_toggle'`

- [ ] **Step 1: Add SMS config seed to initDB()**

In `server/db.js`, find the existing `sysConfigs` array (around line 730) and add SMS entries after the qiniu entries:

```javascript
// After the existing sysConfigs loop, add SMS config
const smsConfigs = [
  ['sms', 'access_key_id', '', 'AccessKey ID', 0],
  ['sms', 'access_key_secret', '', 'AccessKey Secret', 1],
  ['sms', 'sign_name', '', '短信签名', 2],
  ['sms', 'template_code_login', '', '登录验证码模板', 3],
  ['sms', 'template_code_register', '', '注册验证码模板', 4],
  ['sms', 'template_code_reset', '', '重置密码模板', 5],
  ['sms', 'template_code_bind', '', '绑定验证码模板', 6],
]
for (const [cat, key, val, label, order] of smsConfigs) {
  await p.query("INSERT IGNORE INTO system_config (category, `key`, `value`, label, sort_order) VALUES (?, ?, ?, ?, ?)", [cat, key, val, label, order])
}

// Auth toggles
const authToggles = [
  ['auth_toggle', 'email_enabled', 'true', '邮箱注册登录', 0],
  ['auth_toggle', 'phone_enabled', 'true', '手机号注册登录', 1],
]
for (const [cat, key, val, label, order] of authToggles) {
  await p.query("INSERT IGNORE INTO system_config (category, `key`, `value`, label, sort_order) VALUES (?, ?, ?, ?, ?)", [cat, key, val, label, order])
}
```

- [ ] **Step 2: Verify seed data**

Run: `npm run dev`
Expected: Server starts without errors. Verify via MySQL: `SELECT * FROM system_config WHERE category IN ('sms', 'auth_toggle')`

- [ ] **Step 3: Commit**

```bash
git add server/db.js
git commit -m "feat(auth): seed SMS config and auth toggle system_config rows"
```

---

### Task 3: Install Dependencies

**Covers:** [S3]

**Files:**
- Modify: `package.json`

**Interfaces:**
- Produces: `@alicloud/dysmsapi20170525`, `@alicloud/openapi-client`, `svg-captcha` in dependencies

- [ ] **Step 1: Install packages**

Run: `npm install @alicloud/dysmsapi20170525 @alicloud/openapi-client svg-captcha`

- [ ] **Step 2: Verify installation**

Run: `node -e "import('@alicloud/dysmsapi20170525').then(() => console.log('sms ok')); import('svg-captcha').then(() => console.log('captcha ok'))"`
Expected: Both print ok

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add @alicloud/dysmsapi20170525, @alicloud/openapi-client, svg-captcha"
```

---

### Task 4: SMS Utility Module

**Covers:** [S3]

**Files:**
- Create: `server/sms.js`

**Interfaces:**
- Produces:
  - `loadSmsConfig()` → `Promise<{ accessKeyId, accessKeySecret, signName, templateCodes }>`
  - `sendSms(phone, templateCode, templateParams)` → `Promise<{ ok, error?, messageId? }>`
  - `sendVerificationSms(phone, purpose)` → `Promise<{ ok, code, error? }>`
- Consumes: `queryAll` from `server/db.js`

- [ ] **Step 1: Create server/sms.js**

```javascript
import { queryAll, queryRun } from './db.js'

let _smsConfig = null

export async function loadSmsConfig() {
  if (_smsConfig) return _smsConfig
  const rows = await queryAll("SELECT `key`, `value` FROM system_config WHERE category = 'sms'")
  const cfg = {}
  for (const r of rows) cfg[r.key] = r.value
  _smsConfig = {
    accessKeyId: cfg.access_key_id || '',
    accessKeySecret: cfg.access_key_secret || '',
    signName: cfg.sign_name || '',
    templateCodes: {
      login: cfg.template_code_login || '',
      register: cfg.template_code_register || '',
      reset: cfg.template_code_reset || '',
      bind: cfg.template_code_bind || '',
    },
  }
  return _smsConfig
}

export function resetSmsConfig() { _smsConfig = null }

export async function sendSms(phone, templateCode, templateParams = {}) {
  const cfg = await loadSmsConfig()
  if (!cfg.accessKeyId || !cfg.accessKeySecret) {
    return { ok: false, error: '短信服务未配置' }
  }
  if (!templateCode) {
    return { ok: false, error: '短信模板未配置' }
  }

  try {
    const { default: Dysmsapi } = await import('@alicloud/dysmsapi20170525')
    const { default: OpenApiClient } = await import('@alicloud/openapi-client')

    const client = new OpenApiClient({
      accessKeyId: cfg.accessKeyId,
      accessKeySecret: cfg.accessKeySecret,
      endpoint: 'dysmsapi.aliyuncs.com',
    })

    const request = new Dysmsapi.SendSmsRequest({
      phoneNumbers: phone,
      signName: cfg.signName,
      templateCode,
      templateParam: JSON.stringify(templateParams),
    })

    const runtime = { autoretry: true, timeout: 10000 }
    const resp = await new Dysmsapi.default(client).sendSms(request, runtime)

    if (resp.body?.code === 'OK') {
      return { ok: true, messageId: resp.body.bizId }
    }
    return { ok: false, error: resp.body?.message || '短信发送失败' }
  } catch (err) {
    console.error('[SMS] Send error:', err.message)
    return { ok: false, error: '短信发送失败: ' + err.message }
  }
}

export async function sendVerificationSms(phone, purpose) {
  const cfg = await loadSmsConfig()
  const templateCode = cfg.templateCodes[purpose]
  if (!templateCode) {
    return { ok: false, error: `短信模板未配置 (${purpose})` }
  }

  const code = String(Math.floor(100000 + Math.random() * 900000))

  const result = await sendSms(phone, templateCode, { code })
  if (!result.ok) return result

  // Store verification code in DB
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000 + 8 * 3600_000)
    .toISOString().replace('T', ' ').substring(0, 19)

  await queryRun(
    'INSERT INTO verification_codes (phone, code, purpose, expires_at) VALUES (?, ?, ?, ?)',
    [phone, code, purpose, expiresAt]
  )

  return { ok: true, code }
}
```

- [ ] **Step 2: Commit**

```bash
git add server/sms.js
git commit -m "feat(auth): add Alibaba Cloud SMS utility module"
```

---

### Task 5: CAPTCHA Utility Module

**Covers:** [S3, S5]

**Files:**
- Create: `server/captcha.js`

**Interfaces:**
- Produces:
  - `generateCaptcha()` → `{ id: string, svg: string }`
  - `verifyCaptcha(id, code)` → `boolean`

- [ ] **Step 1: Create server/captcha.js**

```javascript
import svgCaptcha from 'svg-captcha'

const captchaStore = new Map()
const CAPTCHA_TTL = 5 * 60 * 1000 // 5 minutes

// Cleanup expired captchas every minute
setInterval(() => {
  const now = Date.now()
  for (const [id, entry] of captchaStore) {
    if (now - entry.createdAt > CAPTCHA_TTL) captchaStore.delete(id)
  }
}, 60_000)

export function generateCaptcha() {
  const captcha = svgCaptcha.create({
    size: 4,
    ignoreChars: '0o1lI',
    noise: 3,
    color: true,
    background: '#f0f0f0',
    width: 120,
    height: 40,
  })

  const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
  captchaStore.set(id, {
    code: captcha.text.toLowerCase(),
    createdAt: Date.now(),
    used: false,
  })

  return { id, svg: captcha.data }
}

export function verifyCaptcha(id, code) {
  if (!id || !code) return false
  const entry = captchaStore.get(id)
  if (!entry || entry.used) return false

  const now = Date.now()
  if (now - entry.createdAt > CAPTCHA_TTL) {
    captchaStore.delete(id)
    return false
  }

  entry.used = true
  return entry.code === code.toLowerCase()
}
```

- [ ] **Step 2: Commit**

```bash
git add server/captcha.js
git commit -m "feat(auth): add SVG CAPTCHA utility module"
```

---

### Task 6: Auth Routes — Phone Registration and Login

**Covers:** [S3, S4, S6]

**Files:**
- Modify: `server/routes/auth.js`

**Interfaces:**
- Consumes: `loadSmsConfig`, `sendSms`, `sendVerificationSms` from `server/sms.js`; `verifyCaptcha` from `server/captcha.js`; `queryOne`, `queryAll`, `queryRun`, `logAudit` from `server/db.js`
- Produces: Modified `/api/register`, `/api/login`, `/api/send-code`, `/api/verify-code`, `/api/reset-password`; New `/api/captcha`, `/api/send-bind-code`, `/api/bind-phone`, `/api/bind-email`, `/api/auth-methods`

- [ ] **Step 1: Add imports and auth-methods endpoint**

At the top of `server/routes/auth.js`, add imports:

```javascript
import { sendSms, sendVerificationSms, loadSmsConfig, resetSmsConfig } from '../sms.js'
import { generateCaptcha, verifyCaptcha } from '../captcha.js'
```

Add new endpoint for auth methods (public):

```javascript
router.get('/auth-methods', async (req, res) => {
  try {
    const rows = await queryAll("SELECT `key`, `value` FROM system_config WHERE category = 'auth_toggle'")
    const toggles = {}
    for (const r of rows) toggles[r.key] = r.value === 'true'
    res.json({
      ok: true,
      emailEnabled: toggles.email_enabled !== false,
      phoneEnabled: toggles.phone_enabled !== false,
    })
  } catch (err) {
    res.json({ ok: true, emailEnabled: true, phoneEnabled: true })
  }
})
```

- [ ] **Step 2: Add CAPTCHA endpoint**

```javascript
router.get('/captcha', async (req, res) => {
  try {
    const { id, svg } = generateCaptcha()
    res.json({ ok: true, id, svg })
  } catch (err) {
    res.json({ ok: false, error: '生成验证码失败' })
  }
})
```

- [ ] **Step 3: Modify /api/register for phone registration**

Replace the register handler to support both email and phone:

```javascript
router.post('/register', async (req, res) => {
  try {
    const { email, phone, password, nickname, referral, referralCode, verifyToken } = req.body

    // Check auth toggles
    const toggleRows = await queryAll("SELECT `key`, `value` FROM system_config WHERE category = 'auth_toggle'")
    const toggles = {}
    for (const r of toggleRows) toggles[r.key] = r.value === 'true'

    if (email && toggles.email_enabled === false) {
      return res.json({ ok: false, error: '邮箱注册已关闭' })
    }
    if (phone && toggles.phone_enabled === false) {
      return res.json({ ok: false, error: '手机号注册已关闭' })
    }

    if (!email && !phone) return res.json({ ok: false, error: '请提供邮箱或手机号' })
    if (!password) return res.json({ ok: false, error: '密码不能为空' })
    if (password.length < 6) return res.json({ ok: false, error: '密码至少6位' })

    // Check uniqueness
    if (email) {
      const existing = await queryOne('SELECT id FROM users WHERE email = ?', [email])
      if (existing) return res.json({ ok: false, error: '该邮箱已注册' })
    }
    if (phone) {
      const existing = await queryOne('SELECT id FROM users WHERE phone = ?', [phone])
      if (existing) return res.json({ ok: false, error: '该手机号已注册' })
      // Require verifyToken for phone registration
      if (!verifyToken) return res.json({ ok: false, error: '请先完成手机验证' })
      const tokenRecord = await queryOne(
        'SELECT id FROM verification_codes WHERE phone = ? AND verify_token = ? AND purpose = ? AND expires_at > NOW()',
        [phone, verifyToken, 'register']
      )
      if (!tokenRecord) return res.json({ ok: false, error: '验证已过期，请重新验证' })
    }

    const hash = await bcrypt.hash(password, 10)
    const code = referralCode || generateReferralCode()
    const ref = referral || null

    let referredBy = null
    if (ref) {
      const referrer = await queryOne('SELECT id FROM users WHERE referral_code = ?', [ref.toUpperCase()])
      if (referrer) referredBy = ref.toUpperCase()
    }

    const displayName = nickname || (email ? email.split('@')[0] : '手机用户')
    const uid = 'WS' + String(Date.now()).slice(-6)

    const result = await queryRun(`
      INSERT INTO users (email, phone, password, nickname, referral_code, referred_by, uid, plan, plan_expires_at, auth_method, email_verified, phone_verified)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pro', DATE_ADD(NOW(), INTERVAL 1 MONTH), ?, ?, ?)
    `, [
      email || null, phone || null, hash, displayName, code, referredBy, uid,
      email ? 'email' : 'phone',
      email ? 1 : 0,
      phone ? 1 : 0,
    ])

    const token = generateToken(result.insertId)
    const user = await queryOne('SELECT id, uid, email, phone, nickname, avatar, role, plan, plan_expires_at, referral_code, referral_credit, auth_method FROM users WHERE id = ?', [result.insertId])
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
```

- [ ] **Step 4: Modify /api/login for phone login**

Replace the login handler:

```javascript
router.post('/login', async (req, res) => {
  try {
    const { email, phone, password, method, verifyToken } = req.body

    // Check auth toggles
    const toggleRows = await queryAll("SELECT `key`, `value` FROM system_config WHERE category = 'auth_toggle'")
    const toggles = {}
    for (const r of toggleRows) toggles[r.key] = r.value === 'true'

    if (email && toggles.email_enabled === false) {
      return res.json({ ok: false, error: '邮箱登录已关闭' })
    }
    if (phone && toggles.phone_enabled === false) {
      return res.json({ ok: false, error: '手机号登录已关闭' })
    }

    if (!email && !phone) return res.json({ ok: false, error: '请输入邮箱或手机号' })

    const user = email
      ? await queryOne('SELECT * FROM users WHERE email = ?', [email])
      : await queryOne('SELECT * FROM users WHERE phone = ?', [phone])

    if (!user) return res.json({ ok: false, error: '账号或密码错误' })

    // Password login
    if (!method || method === 'password') {
      if (!password) return res.json({ ok: false, error: '请输入密码' })
      if (!await bcrypt.compare(password, user.password)) return res.json({ ok: false, error: '账号或密码错误' })
    }
    // Code login
    else if (method === 'code') {
      if (!verifyToken) return res.json({ ok: false, error: '请先完成验证' })
      const identifier = email || phone
      const idField = email ? 'email' : 'phone'
      const tokenRecord = await queryOne(
        `SELECT id FROM verification_codes WHERE ${idField} = ? AND verify_token = ? AND purpose = ? AND expires_at > NOW()`,
        [identifier, verifyToken, 'login']
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
```

- [ ] **Step 5: Modify /api/send-code for phone support**

Replace the send-code handler:

```javascript
router.post('/send-code', async (req, res) => {
  try {
    const { email, phone, purpose, captchaId, captchaCode } = req.body
    const targetEmail = email || req.user?.email
    const targetPhone = phone

    // Verify CAPTCHA first
    if (captchaId) {
      if (!captchaCode || !verifyCaptcha(captchaId, captchaCode)) {
        return res.json({ ok: false, error: '图形验证码错误' })
      }
    }

    if (!targetEmail && !targetPhone) return res.json({ ok: false, error: '请输入邮箱或手机号' })

    // Phone code sending
    if (targetPhone) {
      // Check phone uniqueness for register
      if (purpose === 'register') {
        const existing = await queryOne('SELECT id FROM users WHERE phone = ?', [targetPhone])
        if (existing) return res.json({ ok: false, error: '该手机号已注册' })
      }

      const result = await sendVerificationSms(targetPhone, purpose || 'login')
      if (!result.ok) return res.json({ ok: false, error: result.error })
      return res.json({ ok: true, message: '验证码已发送到您的手机' })
    }

    // Email code sending (existing logic)
    if (purpose === 'register') {
      const existing = await queryOne('SELECT id FROM users WHERE email = ?', [targetEmail])
      if (existing) return res.json({ ok: false, error: '该邮箱已注册' })
    }

    const code = String(Math.floor(100000 + Math.random() * 900000))
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000 + 8 * 3600_000).toISOString().replace('T', ' ').substring(0, 19)

    await queryRun('INSERT INTO verification_codes (email, code, purpose, expires_at) VALUES (?, ?, ?, ?)', [targetEmail, code, purpose || 'login', expiresAt])

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
```

- [ ] **Step 6: Modify /api/verify-code for phone support**

Replace the verify-code handler:

```javascript
router.post('/verify-code', async (req, res) => {
  try {
    const { email, phone, code, purpose } = req.body
    const targetEmail = email || req.user?.email
    const targetPhone = phone

    if (!targetEmail && !targetPhone) return res.json({ ok: false, error: '请输入邮箱或手机号' })

    let record
    if (targetPhone) {
      record = await queryOne(`
        SELECT * FROM verification_codes
        WHERE phone = ? AND code = ? AND purpose = ? AND used = 0 AND expires_at > NOW()
        ORDER BY created_at DESC LIMIT 1
      `, [targetPhone, code, purpose || 'login'])
    } else {
      record = await queryOne(`
        SELECT * FROM verification_codes
        WHERE email = ? AND code = ? AND purpose = ? AND used = 0 AND expires_at > NOW()
        ORDER BY created_at DESC LIMIT 1
      `, [targetEmail, code, purpose || 'login'])
    }

    if (!record) return res.json({ ok: false, error: '验证码无效或已过期' })

    const verifyToken = uuidv4()
    await queryRun('UPDATE verification_codes SET used = 1, verify_token = ? WHERE id = ?', [verifyToken, record.id])
    res.json({ ok: true, message: '验证成功', token: verifyToken })
  } catch (err) {
    res.json({ ok: false, error: '验证失败' })
  }
})
```

- [ ] **Step 7: Modify /api/reset-password for phone support**

Replace the reset-password handler:

```javascript
router.post('/reset-password', async (req, res) => {
  try {
    const { email, phone, newPassword, verifyToken } = req.body
    const targetEmail = email || req.user?.email
    const targetPhone = phone

    if (!targetEmail && !targetPhone) return res.json({ ok: false, error: '请提供邮箱或手机号' })
    if (!newPassword) return res.json({ ok: false, error: '新密码不能为空' })

    if (verifyToken) {
      const idField = targetPhone ? 'phone' : 'email'
      const identifier = targetPhone || targetEmail
      const tokenRecord = await queryOne(
        `SELECT id FROM verification_codes WHERE ${idField} = ? AND verify_token = ? AND purpose = ? AND expires_at > NOW()`,
        [identifier, verifyToken, 'reset']
      )
      if (!tokenRecord) return res.json({ ok: false, error: '验证已过期，请重新验证' })

      const hash = await bcrypt.hash(newPassword, 10)
      if (targetPhone) {
        await queryRun("UPDATE users SET password = ?, updated_at = NOW() WHERE phone = ?", [hash, targetPhone])
      } else {
        await queryRun("UPDATE users SET password = ?, updated_at = NOW() WHERE email = ?", [hash, targetEmail])
      }
      await queryRun('UPDATE verification_codes SET used = 1 WHERE id = ?', [tokenRecord.id])
      return res.json({ ok: true, message: '密码已重置' })
    }

    return res.json({ ok: false, error: '请提供验证码' })
  } catch (err) {
    console.error('Reset password error:', err)
    res.json({ ok: false, error: '重置密码失败' })
  }
})
```

- [ ] **Step 8: Add bind endpoints**

```javascript
router.post('/send-bind-code', authMiddleware, async (req, res) => {
  try {
    const { phone, email: targetEmail, purpose, captchaId, captchaCode } = req.body
    const user = await queryOne('SELECT id, email, phone FROM users WHERE id = ?', [req.user.id])

    // Verify CAPTCHA
    if (captchaId) {
      if (!captchaCode || !verifyCaptcha(captchaId, captchaCode)) {
        return res.json({ ok: false, error: '图形验证码错误' })
      }
    }

    if (purpose === 'bind_phone') {
      if (!phone) return res.json({ ok: false, error: '请输入手机号' })
      if (user.phone) return res.json({ ok: false, error: '已绑定手机号，请先解绑' })
      const existing = await queryOne('SELECT id FROM users WHERE phone = ?', [phone])
      if (existing) return res.json({ ok: false, error: '该手机号已被其他账号绑定' })

      const result = await sendVerificationSms(phone, 'bind')
      if (!result.ok) return res.json({ ok: false, error: result.error })
      return res.json({ ok: true, message: '验证码已发送到您的手机' })
    }

    if (purpose === 'bind_email') {
      if (!targetEmail) return res.json({ ok: false, error: '请输入邮箱' })
      if (user.email) return res.json({ ok: false, error: '已绑定邮箱，请先解绑' })
      const existing = await queryOne('SELECT id FROM users WHERE email = ?', [targetEmail])
      if (existing) return res.json({ ok: false, error: '该邮箱已被其他账号绑定' })

      const code = String(Math.floor(100000 + Math.random() * 900000))
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000 + 8 * 3600_000).toISOString().replace('T', ' ').substring(0, 19)
      await queryRun('INSERT INTO verification_codes (email, code, purpose, expires_at) VALUES (?, ?, ?, ?)', [targetEmail, code, 'bind', expiresAt])

      // Try sending email
      try {
        const smtpConfig = {}
        const rows = await queryAll("SELECT `key`, `value` FROM system_config WHERE category = 'smtp'")
        for (const r of rows) smtpConfig[r.key] = r.value
        if (smtpConfig.host && smtpConfig.user) {
          const transporter = nodemailer.createTransport({
            host: smtpConfig.host, port: Number(smtpConfig.port) || 587,
            secure: smtpConfig.secure === 'true',
            auth: { user: smtpConfig.user, pass: smtpConfig.pass },
          })
          await transporter.sendMail({
            from: { name: smtpConfig.from_name || '量见课堂', address: smtpConfig.from || smtpConfig.user },
            to: targetEmail, subject: '量见课堂 - 绑定验证码',
            html: `<p>您的验证码是：<strong>${code}</strong>，10分钟内有效。</p>`,
          })
        }
      } catch (e) { console.error('Bind email send error:', e.message) }

      return res.json({ ok: true, message: '验证码已发送到您的邮箱' })
    }

    res.json({ ok: false, error: '无效的操作' })
  } catch (err) {
    console.error('[send-bind-code]', err.message)
    res.json({ ok: false, error: '发送验证码失败' })
  }
})

router.post('/bind-phone', authMiddleware, async (req, res) => {
  try {
    const { phone, verifyToken } = req.body
    if (!phone || !verifyToken) return res.json({ ok: false, error: '参数不完整' })

    const user = await queryOne('SELECT id, phone FROM users WHERE id = ?', [req.user.id])
    if (user.phone) return res.json({ ok: false, error: '已绑定手机号' })

    const existing = await queryOne('SELECT id FROM users WHERE phone = ?', [phone])
    if (existing) return res.json({ ok: false, error: '该手机号已被其他账号绑定' })

    const tokenRecord = await queryOne(
      'SELECT id FROM verification_codes WHERE phone = ? AND verify_token = ? AND purpose = ? AND expires_at > NOW()',
      [phone, verifyToken, 'bind']
    )
    if (!tokenRecord) return res.json({ ok: false, error: '验证已过期，请重新验证' })

    await queryRun('UPDATE users SET phone = ?, phone_verified = 1, updated_at = NOW() WHERE id = ?', [phone, req.user.id])
    await queryRun('UPDATE verification_codes SET used = 1 WHERE id = ?', [tokenRecord.id])

    res.json({ ok: true, message: '手机号绑定成功' })
  } catch (err) {
    res.json({ ok: false, error: '绑定失败' })
  }
})

router.post('/bind-email', authMiddleware, async (req, res) => {
  try {
    const { email: targetEmail, verifyToken } = req.body
    if (!targetEmail || !verifyToken) return res.json({ ok: false, error: '参数不完整' })

    const user = await queryOne('SELECT id, email FROM users WHERE id = ?', [req.user.id])
    if (user.email) return res.json({ ok: false, error: '已绑定邮箱' })

    const existing = await queryOne('SELECT id FROM users WHERE email = ?', [targetEmail])
    if (existing) return res.json({ ok: false, error: '该邮箱已被其他账号绑定' })

    const tokenRecord = await queryOne(
      'SELECT id FROM verification_codes WHERE email = ? AND verify_token = ? AND purpose = ? AND expires_at > NOW()',
      [targetEmail, verifyToken, 'bind']
    )
    if (!tokenRecord) return res.json({ ok: false, error: '验证已过期，请重新验证' })

    await queryRun('UPDATE users SET email = ?, email_verified = 1, updated_at = NOW() WHERE id = ?', [targetEmail, req.user.id])
    await queryRun('UPDATE verification_codes SET used = 1 WHERE id = ?', [tokenRecord.id])

    res.json({ ok: true, message: '邮箱绑定成功' })
  } catch (err) {
    res.json({ ok: false, error: '绑定失败' })
  }
})
```

- [ ] **Step 9: Run server and verify no errors**

Run: `npm run dev`
Expected: Server starts without errors

- [ ] **Step 10: Commit**

```bash
git add server/routes/auth.js
git commit -m "feat(auth): add phone registration, login, reset-password, and bind endpoints"
```

---

### Task 7: User Profile — Phone Fields

**Covers:** [S3]

**Files:**
- Modify: `server/routes/user.js`

**Interfaces:**
- Consumes: Modified `users` table with `phone`, `phone_verified`, `auth_method`
- Produces: `GET /api/profile` returns `phone`, `phone_verified`, `auth_method`

- [ ] **Step 1: Update GET /api/profile query**

In `server/routes/user.js`, update the SELECT query in the `GET /profile` handler to include phone fields:

```javascript
const user = await queryOne(`
  SELECT id, uid, email, phone, phone_verified, email_verified, auth_method, nickname, avatar, role, plan, plan_period, plan_expires_at,
         referral_code, referral_credit, telegram_id, telegram_username, telegram_name,
         telegram_chat_id, telegram_group_status, telegram_bot_started_at,
         telegram_joined_at, telegram_last_invite_sent_at, created_at, last_seen_at
  FROM users WHERE id = ?
`, [req.user.id])
```

Also add camelCase aliases:

```javascript
user.phoneVerified = !!user.phone_verified
user.emailVerified = !!user.email_verified
user.authMethod = user.auth_method || 'email'
```

- [ ] **Step 2: Commit**

```bash
git add server/routes/user.js
git commit -m "feat(auth): add phone fields to profile API response"
```

---

### Task 8: Config Routes — Auth Toggle and SMS Test

**Covers:** [S3, S6]

**Files:**
- Modify: `server/routes/config.js`

**Interfaces:**
- Produces: `GET /api/system-config-public/auth_toggle` (public), `POST /api/system-config/sms/test`

- [ ] **Step 1: Add auth_toggle to PUBLIC_CATEGORIES**

In `server/routes/config.js`, add `'auth_toggle'` to the PUBLIC_CATEGORIES set:

```javascript
const PUBLIC_CATEGORIES = new Set(['toolbox', 'market_menu', 'announcements', 'features', 'auth_toggle'])
```

- [ ] **Step 2: Add SMS test endpoint**

```javascript
router.post('/system-config/sms/test', authMiddleware, adminOnly, async (req, res) => {
  try {
    const { to } = req.body
    if (!to) return res.json({ ok: false, error: '请输入测试手机号' })

    const { sendSms, loadSmsConfig } = await import('../sms.js')
    const cfg = await loadSmsConfig()
    if (!cfg.accessKeyId || !cfg.accessKeySecret) {
      return res.json({ ok: false, error: '请先配置阿里云 AccessKey' })
    }
    if (!cfg.signName) {
      return res.json({ ok: false, error: '请先配置短信签名' })
    }

    const result = await sendSms(to, cfg.templateCodes.login || cfg.templateCodes.register, { code: '123456' })
    if (result.ok) {
      res.json({ ok: true })
    } else {
      res.json({ ok: false, error: result.error })
    }
  } catch (err) {
    res.json({ ok: false, error: err.message || '发送失败' })
  }
})
```

- [ ] **Step 3: Commit**

```bash
git add server/routes/config.js
git commit -m "feat(auth): add auth_toggle public endpoint and SMS test endpoint"
```

---

### Task 9: Rate Limiter Update

**Covers:** [S3]

**Files:**
- Modify: `server/index.js`

**Interfaces:**
- Produces: Rate limiters for new phone auth endpoints

- [ ] **Step 1: Add rate limiters for new endpoints**

In `server/index.js`, find the existing rate limiter section (around line 90) and add:

```javascript
app.use('/api/send-bind-code', authLimiter)
app.use('/api/bind-phone', authLimiter)
app.use('/api/bind-email', authLimiter)
```

- [ ] **Step 2: Commit**

```bash
git add server/index.js
git commit -m "feat(auth): add rate limiters for phone bind endpoints"
```

---

### Task 10: Frontend — Auth Modal Phone Modes

**Covers:** [S4]

**Files:**
- Modify: `public/src/main.js`

**Interfaces:**
- Consumes: `GET /api/auth-methods`, `GET /api/captcha`
- Produces: Phone login/register modes in auth modal

- [ ] **Step 1: Add phone auth modes to AUTH_MODE_META**

Find `AUTH_MODE_META` in `public/src/main.js` (around line 6642) and add:

```javascript
login_phone: {
  title: '手机号登录',
  submitLabel: '登录',
  phoneLogin: true,
  passwordLabel: '密码',
  passwordPlaceholder: '请输入密码',
},
login_phone_code: {
  title: '手机验证码登录',
  submitLabel: '登录',
  phoneLogin: true,
  codePurpose: 'login',
},
register_phone: {
  title: '手机号注册',
  submitLabel: '注册',
  phoneRegister: true,
  codePurpose: 'register',
  passwordLabel: '密码',
  passwordPlaceholder: '8-32位，含大写字母、数字、特殊字符',
  showPasswordRules: true,
  showConfirmPassword: true,
  showTos: true,
},
```

- [ ] **Step 2: Update renderAuthModeLinks for phone modes**

Replace the `renderAuthModeLinks` function to support phone modes:

```javascript
function renderAuthModeLinks(mode) {
  const { emailEnabled = true, phoneEnabled = true } = state.authMethods || {}

  if (mode === 'login_password') {
    const links = []
    if (emailEnabled) links.push('<a data-auth-mode="login_code">使用邮箱验证码登录</a>')
    if (phoneEnabled) links.push('<a data-auth-mode="login_phone">使用手机号登录</a>')
    links.push('<a data-auth-mode="reset_password">忘记密码</a>')
    return `<div class="auth-mode-links">${links.join('')}</div>`
  }
  if (mode === 'login_code') {
    const links = ['<a data-auth-mode="login_password">使用密码登录</a>']
    if (phoneEnabled) links.push('<a data-auth-mode="login_phone">使用手机号登录</a>')
    links.push('<a data-auth-mode="reset_password">忘记密码</a>')
    return `<div class="auth-mode-links">${links.join('')}</div>`
  }
  if (mode === 'login_phone') {
    const links = []
    if (emailEnabled) links.push('<a data-auth-mode="login_password">使用密码登录</a>')
    links.push('<a data-auth-mode="login_phone_code">使用手机验证码登录</a>')
    links.push('<a data-auth-mode="reset_password">忘记密码</a>')
    return `<div class="auth-mode-links">${links.join('')}</div>`
  }
  if (mode === 'login_phone_code') {
    const links = ['<a data-auth-mode="login_phone">使用密码登录</a>']
    if (emailEnabled) links.push('<a data-auth-mode="login_password">使用邮箱密码登录</a>')
    links.push('<a data-auth-mode="reset_password">忘记密码</a>')
    return `<div class="auth-mode-links">${links.join('')}</div>`
  }
  if (mode === 'register_phone') {
    return `<div class="auth-mode-links"><a data-auth-mode="login_phone">已有账号？立即登录</a></div>`
  }
  if (mode === 'reset_password') {
    const links = ['<a data-auth-mode="login_password">返回密码登录</a>']
    if (emailEnabled) links.push('<a data-auth-mode="login_code">使用验证码登录</a>')
    if (phoneEnabled) links.push('<a data-auth-mode="login_phone">使用手机号登录</a>')
    return `<div class="auth-mode-links">${links.join('')}</div>`
  }
  return ''
}
```

- [ ] **Step 3: Update renderAuthFooter for phone modes**

```javascript
function renderAuthFooter(mode) {
  if (mode === 'register' || mode === 'register_phone') {
    return '已有账号？<a data-auth-mode="login_password">立即登录</a>'
  }
  const { emailEnabled = true, phoneEnabled = true } = state.authMethods || {}
  const links = []
  links.push('还没有账号？')
  if (emailEnabled) links.push('<a data-auth-mode="register">邮箱注册</a>')
  if (phoneEnabled) links.push('<a data-auth-mode="register_phone">手机号注册</a>')
  return links.join('')
}
```

- [ ] **Step 4: Load auth methods on app init**

Find where `showAuthModal` is called or where the auth state is initialized, and add:

```javascript
// Load auth methods when auth modal opens
async function loadAuthMethods() {
  try {
    const res = await api.get('/api/auth-methods')
    if (res.ok) {
      state.authMethods = { emailEnabled: res.emailEnabled, phoneEnabled: res.phoneEnabled }
    }
  } catch (e) { /* ignore */ }
}
```

Call `loadAuthMethods()` at the start of `showAuthModal`.

- [ ] **Step 5: Update form rendering for phone inputs**

In the auth modal form rendering, add phone input field when mode is `login_phone`, `login_phone_code`, or `register_phone`:

```javascript
// In the form rendering, check if mode needs phone input
const needsPhone = meta.phoneLogin || meta.phoneRegister
const needsEmail = !meta.phoneLogin && !meta.phoneRegister

if (needsPhone) {
  // Render phone input instead of email input
  html += `
    <div class="form-group">
      <label class="form-label">手机号</label>
      <div class="form-row">
        <select class="form-select" id="phonePrefix" style="width:80px">
          <option value="+86">+86</option>
        </select>
        <input type="tel" class="form-input" id="authPhone" placeholder="请输入手机号" maxlength="11">
      </div>
    </div>
  `
} else {
  // Render email input (existing logic)
}
```

- [ ] **Step 6: Update form submission for phone modes**

In the form submit handler, add phone-specific logic:

```javascript
// In the submit handler, check auth mode
if (state.authMode === 'register_phone') {
  const phone = document.getElementById('authPhone')?.value?.trim()
  if (!phone) return showFormMsg('请输入手机号', 'err')
  // ... send code and register with phone
}

if (state.authMode === 'login_phone') {
  const phone = document.getElementById('authPhone')?.value?.trim()
  const password = document.getElementById('authPassword')?.value
  if (!phone) return showFormMsg('请输入手机号', 'err')
  // ... login with phone + password
}

if (state.authMode === 'login_phone_code') {
  const phone = document.getElementById('authPhone')?.value?.trim()
  if (!phone) return showFormMsg('请输入手机号', 'err')
  // ... login with phone + code
}
```

- [ ] **Step 7: Add CAPTCHA display before send-code**

When user clicks "发送验证码", show CAPTCHA first:

```javascript
async function handleSendCode() {
  const meta = getAuthModeMeta(state.authMode)
  if (!meta.codePurpose) return

  // Show CAPTCHA first
  const captchaRes = await api.get('/api/captcha')
  if (!captchaRes.ok) return showFormMsg('获取验证码失败', 'err')

  // Show CAPTCHA modal/popup
  showCaptchaModal(captchaRes.id, captchaRes.svg, async (captchaId, captchaCode) => {
    // After CAPTCHA verified, send code
    const phone = document.getElementById('authPhone')?.value?.trim()
    const email = document.getElementById('authEmail')?.value?.trim()

    const res = await api.post('/api/send-code', {
      email, phone,
      purpose: meta.codePurpose,
      captchaId, captchaCode,
    })
    // ... handle response
  })
}
```

- [ ] **Step 8: Commit**

```bash
git add public/src/main.js
git commit -m "feat(auth): add phone login/register modes to auth modal"
```

---

### Task 11: Frontend — Account Settings Phone Binding

**Covers:** [S4]

**Files:**
- Modify: `public/src/main.js`

**Interfaces:**
- Consumes: `GET /api/profile` (returns `phone`, `auth_method`), `POST /api/send-bind-code`, `POST /api/bind-phone`, `POST /api/bind-email`
- Produces: Phone/email binding UI in account settings

- [ ] **Step 1: Add binding cards to account settings**

In the account settings section (`settingsTab === 'account'`), add binding cards after the existing email display:

```javascript
// After the existing email display card
${state.user.authMethod === 'email' && !state.user.phone ? `
  <div class="settings-card">
    <h3 class="settings-card-title">绑定手机号</h3>
    <p class="settings-hint">绑定手机号后可使用手机号登录</p>
    <div class="form-group">
      <div class="form-row">
        <select class="form-select" id="bindPhonePrefix" style="width:80px">
          <option value="+86">+86</option>
        </select>
        <input type="tel" class="form-input" id="bindPhone" placeholder="请输入手机号" maxlength="11">
      </div>
    </div>
    <div class="form-group" id="bindPhoneCodeGroup" style="display:none">
      <div class="form-row">
        <input type="text" class="form-input" id="bindPhoneCode" placeholder="输入6位验证码" maxlength="6">
        <button class="btn-send-code" id="bindPhoneSendCode">发送验证码</button>
      </div>
    </div>
    <button class="btn btn-primary" id="bindPhoneBtn" style="width:100%">绑定手机号</button>
    <div id="bindPhoneMsg" class="settings-msg" style="display:none"></div>
  </div>
` : ''}

${state.user.authMethod === 'phone' && !state.user.email ? `
  <div class="settings-card">
    <h3 class="settings-card-title">绑定邮箱</h3>
    <p class="settings-hint">绑定邮箱后可使用邮箱登录</p>
    <div class="form-group">
      <input type="email" class="form-input" id="bindEmail" placeholder="请输入邮箱">
    </div>
    <div class="form-group" id="bindEmailCodeGroup" style="display:none">
      <div class="form-row">
        <input type="text" class="form-input" id="bindEmailCode" placeholder="输入6位验证码" maxlength="6">
        <button class="btn-send-code" id="bindEmailSendCode">发送验证码</button>
      </div>
    </div>
    <button class="btn btn-primary" id="bindEmailBtn" style="width:100%">绑定邮箱</button>
    <div id="bindEmailMsg" class="settings-msg" style="display:none"></div>
  </div>
` : ''}
```

- [ ] **Step 2: Add binding event handlers**

After rendering the settings, add event handlers for binding:

```javascript
// Phone binding
document.getElementById('bindPhoneSendCode')?.addEventListener('click', async () => {
  const phone = document.getElementById('bindPhone')?.value?.trim()
  if (!phone || phone.length !== 11) return showSettingsMsg('bindPhoneMsg', '请输入有效手机号', 'err')

  // Show CAPTCHA first
  const captchaRes = await api.get('/api/captcha')
  if (!captchaRes.ok) return showSettingsMsg('bindPhoneMsg', '获取验证码失败', 'err')

  showCaptchaModal(captchaRes.id, captchaRes.svg, async (captchaId, captchaCode) => {
    const res = await api.post('/api/send-bind-code', {
      phone, purpose: 'bind_phone', captchaId, captchaCode,
    })
    if (res.ok) {
      document.getElementById('bindPhoneCodeGroup').style.display = 'block'
      showSettingsMsg('bindPhoneMsg', '验证码已发送', 'ok')
    } else {
      showSettingsMsg('bindPhoneMsg', res.error || '发送失败', 'err')
    }
  })
})

document.getElementById('bindPhoneBtn')?.addEventListener('click', async () => {
  const phone = document.getElementById('bindPhone')?.value?.trim()
  const code = document.getElementById('bindPhoneCode')?.value?.trim()
  if (!phone || !code) return showSettingsMsg('bindPhoneMsg', '请填写完整', 'err')

  // First verify code
  const verifyRes = await api.post('/api/verify-code', { phone, code, purpose: 'bind' })
  if (!verifyRes.ok) return showSettingsMsg('bindPhoneMsg', verifyRes.error || '验证码错误', 'err')

  // Then bind
  const bindRes = await api.post('/api/bind-phone', { phone, verifyToken: verifyRes.token })
  if (bindRes.ok) {
    showSettingsMsg('bindPhoneMsg', '绑定成功', 'ok')
    state.user.phone = phone
    state.user.phoneVerified = true
    // Re-render settings
    renderSettings()
  } else {
    showSettingsMsg('bindPhoneMsg', bindRes.error || '绑定失败', 'err')
  }
})

// Email binding (similar pattern)
document.getElementById('bindEmailSendCode')?.addEventListener('click', async () => {
  const email = document.getElementById('bindEmail')?.value?.trim()
  if (!email || !email.includes('@')) return showSettingsMsg('bindEmailMsg', '请输入有效邮箱', 'err')

  const captchaRes = await api.get('/api/captcha')
  if (!captchaRes.ok) return showSettingsMsg('bindEmailMsg', '获取验证码失败', 'err')

  showCaptchaModal(captchaRes.id, captchaRes.svg, async (captchaId, captchaCode) => {
    const res = await api.post('/api/send-bind-code', {
      email, purpose: 'bind_email', captchaId, captchaCode,
    })
    if (res.ok) {
      document.getElementById('bindEmailCodeGroup').style.display = 'block'
      showSettingsMsg('bindEmailMsg', '验证码已发送', 'ok')
    } else {
      showSettingsMsg('bindEmailMsg', res.error || '发送失败', 'err')
    }
  })
})

document.getElementById('bindEmailBtn')?.addEventListener('click', async () => {
  const email = document.getElementById('bindEmail')?.value?.trim()
  const code = document.getElementById('bindEmailCode')?.value?.trim()
  if (!email || !code) return showSettingsMsg('bindEmailMsg', '请填写完整', 'err')

  const verifyRes = await api.post('/api/verify-code', { email, code, purpose: 'bind' })
  if (!verifyRes.ok) return showSettingsMsg('bindEmailMsg', verifyRes.error || '验证码错误', 'err')

  const bindRes = await api.post('/api/bind-email', { email, verifyToken: verifyRes.token })
  if (bindRes.ok) {
    showSettingsMsg('bindEmailMsg', '绑定成功', 'ok')
    state.user.email = email
    state.user.emailVerified = true
    renderSettings()
  } else {
    showSettingsMsg('bindEmailMsg', bindRes.error || '绑定失败', 'err')
  }
})
```

- [ ] **Step 3: Commit**

```bash
git add public/src/main.js
git commit -m "feat(auth): add phone/email binding UI in account settings"
```

---

### Task 12: Frontend — Admin Panel SMS Config and Auth Toggles

**Covers:** [S4, S6]

**Files:**
- Modify: `public/src/main.js`

**Interfaces:**
- Consumes: `GET /api/system-config`, `PUT /api/system-config/sms`, `PUT /api/system-config/auth_toggle`, `POST /api/system-config/sms/test`
- Produces: SMS config tab and auth toggle tab in admin panel

- [ ] **Step 1: Add tab buttons to admin config**

In the admin config section (around line 3667), add new tab buttons:

```javascript
<button class="admin-board-tab" type="button" data-config-tab="sms">短信服务</button>
<button class="admin-board-tab" type="button" data-config-tab="auth_toggle">登录注册</button>
```

- [ ] **Step 2: Add case statements in renderAdminConfigContent**

In the switch statement (around line 3710), add:

```javascript
case 'sms':
  renderSmsConfig(container)
  break
case 'auth_toggle':
  renderAuthToggleConfig(container)
  break
```

- [ ] **Step 3: Add renderSmsConfig function**

```javascript
function renderSmsConfig(container) {
  const items = adminConfigData.sms || []
  const getVal = (key) => items.find(i => i.key === key)?.value || ''

  container.innerHTML = `
    <div class="admin-config-form">
      <div class="admin-config-row">
        <label>AccessKey ID</label>
        <input type="text" class="admin-plan-input" id="smsAccessKeyId" value="${escapeHtml(getVal('access_key_id'))}" placeholder="阿里云 AccessKey ID">
      </div>
      <div class="admin-config-row">
        <label>AccessKey Secret</label>
        <input type="password" class="admin-plan-input" id="smsAccessKeySecret" value="${escapeHtml(getVal('access_key_secret'))}" placeholder="阿里云 AccessKey Secret">
      </div>
      <div class="admin-config-row">
        <label>短信签名</label>
        <input type="text" class="admin-plan-input" id="smsSignName" value="${escapeHtml(getVal('sign_name'))}" placeholder="量见课堂">
      </div>
      <div class="admin-config-row">
        <label>登录验证码模板</label>
        <input type="text" class="admin-plan-input" id="smsTemplateLogin" value="${escapeHtml(getVal('template_code_login'))}" placeholder="SMS_XXXXXX">
      </div>
      <div class="admin-config-row">
        <label>注册验证码模板</label>
        <input type="text" class="admin-plan-input" id="smsTemplateRegister" value="${escapeHtml(getVal('template_code_register'))}" placeholder="SMS_XXXXXX">
      </div>
      <div class="admin-config-row">
        <label>重置密码模板</label>
        <input type="text" class="admin-plan-input" id="smsTemplateReset" value="${escapeHtml(getVal('template_code_reset'))}" placeholder="SMS_XXXXXX">
      </div>
      <div class="admin-config-row">
        <label>绑定验证码模板</label>
        <input type="text" class="admin-plan-input" id="smsTemplateBind" value="${escapeHtml(getVal('template_code_bind'))}" placeholder="SMS_XXXXXX">
      </div>
      <div class="admin-config-actions">
        <button class="btn btn-primary" id="saveSmsConfig">保存配置</button>
        <button class="btn btn-ghost" id="testSmsConfig">发送测试短信</button>
      </div>
      <div id="smsTestResult" class="admin-config-test-result"></div>
    </div>
  `

  document.getElementById('saveSmsConfig')?.addEventListener('click', async () => {
    const items = [
      { key: 'access_key_id', value: document.getElementById('smsAccessKeyId').value, label: 'AccessKey ID', sort_order: 0 },
      { key: 'access_key_secret', value: document.getElementById('smsAccessKeySecret').value, label: 'AccessKey Secret', sort_order: 1 },
      { key: 'sign_name', value: document.getElementById('smsSignName').value, label: '短信签名', sort_order: 2 },
      { key: 'template_code_login', value: document.getElementById('smsTemplateLogin').value, label: '登录验证码模板', sort_order: 3 },
      { key: 'template_code_register', value: document.getElementById('smsTemplateRegister').value, label: '注册验证码模板', sort_order: 4 },
      { key: 'template_code_reset', value: document.getElementById('smsTemplateReset').value, label: '重置密码模板', sort_order: 5 },
      { key: 'template_code_bind', value: document.getElementById('smsTemplateBind').value, label: '绑定验证码模板', sort_order: 6 },
    ]
    const res = await api.put('/api/system-config/sms', { items })
    if (res.ok) {
      showToast('短信配置已保存', 'success')
      resetSmsConfig && resetSmsConfig() // Reset cached config
      loadAdminConfig()
    } else {
      showToast(res.error || '保存失败', 'error')
    }
  })

  document.getElementById('testSmsConfig')?.addEventListener('click', async () => {
    const resultEl = document.getElementById('smsTestResult')
    const testPhone = prompt('请输入测试手机号：')
    if (!testPhone) return
    resultEl.innerHTML = '<span style="color:var(--text-3)">发送中...</span>'
    const res = await api.post('/api/system-config/sms/test', { to: testPhone })
    if (res.ok) {
      resultEl.innerHTML = '<span style="color:#10b981">✓ 测试短信已发送，请检查手机</span>'
    } else {
      resultEl.innerHTML = `<span style="color:#ef4444">✗ ${escapeHtml(res.error || '发送失败')}</span>`
    }
  })
}
```

- [ ] **Step 4: Add renderAuthToggleConfig function**

```javascript
function renderAuthToggleConfig(container) {
  const items = adminConfigData.auth_toggle || []
  const getVal = (key) => items.find(i => i.key === key)?.value || 'true'

  container.innerHTML = `
    <div class="admin-config-form">
      <div class="admin-config-row">
        <label>邮箱注册登录</label>
        <select class="admin-plan-select" id="authEmailEnabled">
          <option value="true" ${getVal('email_enabled') === 'true' ? 'selected' : ''}>开启</option>
          <option value="false" ${getVal('email_enabled') === 'false' ? 'selected' : ''}>关闭</option>
        </select>
      </div>
      <div class="admin-config-row">
        <label>手机号注册登录</label>
        <select class="admin-plan-select" id="authPhoneEnabled">
          <option value="true" ${getVal('phone_enabled') === 'true' ? 'selected' : ''}>开启</option>
          <option value="false" ${getVal('phone_enabled') === 'false' ? 'selected' : ''}>关闭</option>
        </select>
      </div>
      <div class="admin-config-actions">
        <button class="btn btn-primary" id="saveAuthToggle">保存配置</button>
      </div>
    </div>
  `

  document.getElementById('saveAuthToggle')?.addEventListener('click', async () => {
    const items = [
      { key: 'email_enabled', value: document.getElementById('authEmailEnabled').value, label: '邮箱注册登录', sort_order: 0 },
      { key: 'phone_enabled', value: document.getElementById('authPhoneEnabled').value, label: '手机号注册登录', sort_order: 1 },
    ]
    const res = await api.put('/api/system-config/auth_toggle', { items })
    if (res.ok) {
      showToast('登录注册配置已保存', 'success')
      loadAdminConfig()
    } else {
      showToast(res.error || '保存失败', 'error')
    }
  })
}
```

- [ ] **Step 5: Commit**

```bash
git add public/src/main.js
git commit -m "feat(auth): add SMS config and auth toggle tabs to admin panel"
```

---

### Task 13: Verification — Server Startup

**Covers:** All

**Files:** None (verification only)

**Interfaces:**
- Consumes: All previous tasks
- Produces: Verified working server

- [ ] **Step 1: Run tests**

Run: `npm test`
Expected: All 124+ tests pass

- [ ] **Step 2: Start server and verify**

Run: `npm run dev`
Expected: Server starts without `[FATAL]` errors

- [ ] **Step 3: Verify API endpoints**

Test manually or via curl:
- `GET /api/auth-methods` → `{ ok: true, emailEnabled: true, phoneEnabled: true }`
- `GET /api/captcha` → `{ ok: true, id: "...", svg: "..." }`
- `POST /api/send-code` with CAPTCHA → sends SMS (if configured)

- [ ] **Step 4: Commit final state**

```bash
git add -A
git commit -m "feat(auth): complete phone authentication system"
```
