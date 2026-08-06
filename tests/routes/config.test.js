import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import http from 'http'

const { transactionRunner } = vi.hoisted(() => ({ transactionRunner: vi.fn() }))

vi.mock('../../server/db.js', () => ({
  queryOne: vi.fn(),
  queryAll: vi.fn(),
  queryRun: vi.fn(),
  withTransaction: vi.fn(async callback => callback(transactionRunner)),
  logAudit: vi.fn(),
}))

vi.mock('../../server/middleware/auth.js', () => ({
  authMiddleware: (req, res, next) => {
    req.user = { id: 1, role: 'admin' }
    next()
  },
  adminOnly: (req, res, next) => next(),
}))

vi.mock('../../server/crypto/fixed-address.js', () => ({
  resetFixedAddressCache: vi.fn(),
}))

vi.mock('../../server/sms.js', () => ({
  resetSmsConfigCache:vi.fn(),
  loadSmsConfig:vi.fn(),
  sendSms:vi.fn(),
}))

import { queryAll, queryOne, queryRun, withTransaction } from '../../server/db.js'
import { loadSmsConfig, sendSms } from '../../server/sms.js'
import configRouter from '../../server/routes/config.js'
import { sanitizeReleaseNote } from '../../server/html-sanitizer.js'

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/api', configRouter)
  return app
}

function httpReq(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port
      const opts = { hostname: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json' } }
      const req = http.request(opts, (res) => {
        let data = ''
        res.on('data', chunk => data += chunk)
        res.on('end', () => { server.close(); resolve(JSON.parse(data)) })
      })
      req.on('error', reject)
      if (body) req.write(JSON.stringify(body))
      req.end()
    })
  })
}

function httpReqWithStatus(app, method, path, body) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port
      const opts = { hostname: '127.0.0.1', port, path, method, headers: { 'Content-Type': 'application/json' } }
      const req = http.request(opts, (res) => {
        let data = ''
        res.on('data', chunk => data += chunk)
        res.on('end', () => { server.close(); resolve({ status:res.statusCode, body:JSON.parse(data) }) })
      })
      req.on('error', reject)
      if (body) req.write(JSON.stringify(body))
      req.end()
    })
  })
}

describe('config.js — GET /system-config-public/:category', () => {
  beforeEach(() => vi.clearAllMocks())

  it('公开类别返回配置', async () => {
    queryAll.mockResolvedValueOnce([{ key: 'items', value: '[]', category: 'toolbox' }])
    const body = await httpReq(makeApp(), 'GET', '/api/system-config-public/toolbox')
    expect(body.ok).toBe(true)
    expect(body.items).toHaveLength(1)
  })

  it('非公开类别返回 403', async () => {
    // express doesn't auto-set status in our test helper, check error message
    const body = await httpReq(makeApp(), 'GET', '/api/system-config-public/smtp')
    expect(body.error).toBe('Forbidden')
  })
})

describe('config.js — admin credential redaction', () => {
  beforeEach(() => vi.clearAllMocks())

  it('只返回白名单配置，并对敏感值脱敏', async () => {
    queryAll.mockResolvedValueOnce([
      { category:'smtp', key:'pass', value:'fake-mail-password' },
      { category:'ai_provider', key:'deepseek_api_key', value:'fake-api-key' },
      { category:'crypto_wallet', key:'solana_rpc_url', value:'https://rpc.example.test/key' },
      { category:'smtp', key:'host', value:'smtp.example.test' },
    ])
    const body = await httpReq(makeApp(), 'GET', '/api/system-config')
    expect(body.ok).toBe(true)
    const values = Object.fromEntries(Object.values(body.config).flat().map(item => [item.key, item.value]))
    expect(values.pass).toBe('***REDACTED***')
    expect(values.deepseek_api_key).toBeUndefined()
    expect(values.solana_rpc_url).toBeUndefined()
    expect(values.host).toBe('smtp.example.test')
    expect(body.config.ai_provider).toBeUndefined()
  })

  it('拒绝后台白名单之外的配置分类', async () => {
    const body = await httpReq(makeApp(), 'PUT', '/api/system-config/ai_provider', { items:[{ key:'deepseek_api_key', value:'secret' }] })
    expect(body.ok).toBe(false)
    expect(body.error).toContain('不可在后台修改')
    expect(queryRun).not.toHaveBeenCalled()
  })

  it('支付模式由执行合约锁定为固定 TRC-20', async () => {
    const body = await httpReq(makeApp(), 'PUT', '/api/system-config/crypto_wallet', { items:[{ key:'payment_mode', value:'dynamic' }] })
    expect(body.ok).toBe(false)
    expect(body.error).toContain('执行合约锁定')
    expect(queryRun).not.toHaveBeenCalled()
  })
})

describe('config.js — GET /changelog/current', () => {
  beforeEach(() => vi.clearAllMocks())

  it('返回当前版本号和内容', async () => {
    queryAll.mockResolvedValueOnce([{ key:'version', value:'5' }, { key:'content', value:'更新内容' }])
    const body = await httpReq(makeApp(), 'GET', '/api/changelog/current')
    expect(body.ok).toBe(true)
    expect(body.version).toBe(5)
    expect(body.content).toBe('更新内容')
  })

  it('无配置时返回默认值', async () => {
    queryAll.mockResolvedValue([])
    const body = await httpReq(makeApp(), 'GET', '/api/changelog/current')
    expect(body.ok).toBe(true)
    expect(body.version).toBe(1)
    expect(body.content).toBe('')
  })
})

describe('config.js — release note safety and concurrency contract', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    transactionRunner.mockReset()
    withTransaction.mockImplementation(async callback => callback(transactionRunner))
  })

  function configureTransaction({ version = '5', content = '旧内容', user = { email:'admin@example.test', nickname:'管理员' }, failAt = '' } = {}) {
    let index = 0
    transactionRunner.mockImplementation(async (sql) => {
      index += 1
      if (failAt && sql.includes(failAt)) throw new Error('simulated transaction failure')
      if (sql.includes('SELECT `key`, `value` FROM system_config')) return [[{ key:'version', value:version }, { key:'content', value:content }], []]
      if (sql.includes('SELECT email, nickname FROM users')) return [[user], []]
      return [{ affectedRows:1, insertId:1 }, []]
    })
    return () => index
  }

  it('returns a sanitized public payload and deterministic revision', async () => {
    queryAll.mockResolvedValueOnce([{ key:'version', value:'5' }, { key:'content', value:'<script>alert(1)</script><h2 style="color:#c90;position:absolute">安全内容</h2>' }])
    const body = await httpReq(makeApp(), 'GET', '/api/changelog/current')
    const sanitized = sanitizeReleaseNote('<script>alert(1)</script><h2 style="color:#c90;position:absolute">安全内容</h2>')
    expect(body.content).toBe(sanitized.content)
    expect(body.revision).toMatch(/^[a-f0-9]{64}$/)
    expect(body.content).not.toContain('<script')
    expect(body.removed_categories).toEqual(expect.arrayContaining(['script', 'dangerous_style']))
  })

  it('previews through the same server sanitizer without opening a transaction', async () => {
    const body = await httpReq(makeApp(), 'POST', '/api/admin/release-notes/preview', { content:'<h2>标题</h2><a href="javascript:bad()" onclick="bad()">链接</a>' })
    expect(body.ok).toBe(true)
    expect(body.content).toContain('<h2>标题</h2>')
    expect(body.content).not.toContain('javascript:')
    expect(body.removed_categories).toEqual(expect.arrayContaining(['dangerous_url', 'event_attribute']))
    expect(withTransaction).not.toHaveBeenCalled()
  })

  it.each([
    ['0'], ['-1'], ['1.5'], [''], [' '], ['NaN'], ['1abc'], ['2147483648'],
  ])('rejects invalid notification sequence %j with 400 and no transaction', async (version) => {
    const result = await httpReqWithStatus(makeApp(), 'POST', '/api/admin/release-notes', { version, content:'内容' })
    expect(result.status).toBe(400)
    expect(result.body).toMatchObject({ ok:false, code:'release_notes_version_invalid' })
    expect(withTransaction).not.toHaveBeenCalled()
  })

  it('updates both rows and writes an audit without logging body text', async () => {
    configureTransaction({ version:'5', content:'旧内容' })
    const result = await httpReqWithStatus(makeApp(), 'POST', '/api/admin/release-notes', { version:'6', content:'<p>新内容</p>' })
    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ ok:true, version:6, content:'<p>新内容</p>', legacy_write:true })
    expect(transactionRunner).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE'), expect.any(Array))
    expect(transactionRunner).toHaveBeenCalledWith(expect.stringContaining("'release_notes_updated'"), expect.arrayContaining([expect.anything(), expect.any(String), expect.any(String), expect.stringContaining('old_content_hash')]))
    const auditCall = transactionRunner.mock.calls.find(([sql]) => sql.includes("'release_notes_updated'"))
    expect(JSON.stringify(auditCall)).not.toContain('新内容')
  })

  it('rejects a stale revision and a lower sequence with 409 before updates', async () => {
    configureTransaction({ version:'5', content:'旧内容' })
    const stale = await httpReqWithStatus(makeApp(), 'POST', '/api/admin/release-notes', { version:'5', content:'新内容', expected_revision:'0'.repeat(64) })
    expect(stale.status).toBe(409)
    expect(stale.body.code).toBe('release_notes_revision_conflict')
    expect(transactionRunner.mock.calls.some(([sql]) => sql.startsWith('UPDATE system_config'))).toBe(false)

    transactionRunner.mockClear()
    configureTransaction({ version:'5', content:'旧内容' })
    const lower = await httpReqWithStatus(makeApp(), 'POST', '/api/admin/release-notes', { version:'4', content:'新内容' })
    expect(lower.status).toBe(409)
    expect(lower.body.code).toBe('release_notes_version_behind')
  })

  it('keeps the transaction boundary when a later write fails', async () => {
    configureTransaction({ version:'5', content:'旧内容', failAt:'UPDATE system_config SET `value` = ?' })
    const result = await httpReqWithStatus(makeApp(), 'POST', '/api/admin/release-notes', { version:'6', content:'新内容' })
    expect(result.status).toBe(500)
    expect(result.body).toMatchObject({ ok:false, code:'release_notes_update_failed' })
    expect(withTransaction).toHaveBeenCalledTimes(1)
  })

  it('does not silently rewrite stored legacy HTML when an old client omits content', async () => {
    configureTransaction({ version:'5', content:'<div style="display:grid">存量内容</div>' })
    const result = await httpReqWithStatus(makeApp(), 'POST', '/api/admin/release-notes', { version:'6' })
    expect(result.status).toBe(200)
    const contentUpdates = transactionRunner.mock.calls.filter(([sql]) => sql.startsWith('UPDATE system_config SET `value` = ?') && sql.includes('`key` = ?'))
    expect(contentUpdates).toHaveLength(1)
    expect(contentUpdates[0][1]).toEqual(['6','changelog','version'])
  })

  it('is idempotent and keeps only approved release styles', () => {
    const input = '<p style="color:#123456;padding:4px;position:absolute">正文</p>'
    const once = sanitizeReleaseNote(input)
    const twice = sanitizeReleaseNote(once.content)
    expect(twice.content).toBe(once.content)
    expect(once.removedCategories).toContain('dangerous_style')
    expect(once.content).toContain('color:#123456')
    expect(once.content).not.toContain('position')
  })
})

describe('config.js — membership expiry SMS test', () => {
  beforeEach(() => vi.clearAllMocks())

  it('uses the approved membership template parameters', async () => {
    loadSmsConfig.mockResolvedValue({
      accessKeyId:'key', accessKeySecret:'secret', signName:'量见',
      templateCodes:{ membership_expiry:'SMS_EXPIRY' },
    })
    sendSms.mockResolvedValue({ code:'OK' })
    const body = await httpReq(makeApp(), 'POST', '/api/system-config/sms/test', {
      to:'13800138000', template:'membership_expiry',
    })
    expect(body.ok).toBe(true)
    expect(sendSms).toHaveBeenCalledWith('13800138000', 'SMS_EXPIRY', {
      plan:'Pro', expire_date:'2026-07-30', days:'7',
    })
  })

  it('uses a separate expired-membership template without a days parameter', async () => {
    loadSmsConfig.mockResolvedValue({
      accessKeyId:'key', accessKeySecret:'secret', signName:'量见',
      templateCodes:{ membership_expired:'SMS_EXPIRED' },
    })
    sendSms.mockResolvedValue({ code:'OK' })
    const body = await httpReq(makeApp(), 'POST', '/api/system-config/sms/test', {
      to:'13800138000', template:'membership_expired',
    })
    expect(body.ok).toBe(true)
    expect(sendSms).toHaveBeenCalledWith('13800138000', 'SMS_EXPIRED', {
      plan:'Pro', expire_date:'2026-07-30',
    })
  })
})
