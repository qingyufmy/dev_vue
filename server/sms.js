import Dysmsapi from '@alicloud/dysmsapi20170525'
import * as OpenApi from '@alicloud/openapi-client'
import { queryAll, queryRun } from './db.js'
import { systemConfigRowsToMap } from './system-config-secrets.js'

let cachedConfig = null

export async function loadSmsConfig() {
  if (cachedConfig) return cachedConfig

  const rows = await queryAll(
    "SELECT `key`, `value` FROM system_config WHERE category = 'sms'"
  )

  if (!rows.length) {
    throw new Error('[SMS] No sms config found in system_config')
  }

  const map = systemConfigRowsToMap(rows)

  cachedConfig = {
    accessKeyId: map.access_key_id || '',
    accessKeySecret: map.access_key_secret || '',
    signName: map.sign_name || '',
    templateCodes: {
      login: map.template_code_login || '',
      register: map.template_code_register || '',
      reset: map.template_code_reset || '',
      bind: map.template_code_bind || '',
      change: map.template_code_reset || '',
      change_password: map.template_code_reset || '',
      change_phone: map.template_code_bind || '',
      change_email: map.template_code_reset || '',
      membership_expiry: map.template_code_membership_expiry || '',
      membership_expired: map.template_code_membership_expired || '',
    },
  }

  return cachedConfig
}

export function resetSmsConfigCache() {
  cachedConfig = null
}

export async function sendSms(phone, templateCode, templateParams = {}) {
  const cfg = await loadSmsConfig()

  if (!cfg.accessKeyId || !cfg.accessKeySecret) {
    throw new Error('[SMS] AccessKey 未配置')
  }
  if (!cfg.signName) {
    throw new Error('[SMS] 短信签名未配置')
  }
  if (!templateCode) {
    throw new Error('[SMS] 短信模板未配置')
  }

  const config = new OpenApi.Config({
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

  const client = new Dysmsapi.default(config)
  const resp = await client.sendSms(request, {})

  if (resp.body?.code !== 'OK') {
    console.error('[SMS] Send failed:', resp.body?.code, resp.body?.message)
    throw new Error(`SMS send failed: ${resp.body?.message || 'unknown error'}`)
  }

  return resp.body
}

export async function sendVerificationSms(phone, purpose = 'login') {
  const code = String(Math.floor(100000 + Math.random() * 900000))

  const cfg = await loadSmsConfig()
  const templateCode = cfg.templateCodes[purpose]
  if (!templateCode) {
    throw new Error(`[SMS] No template code for purpose: ${purpose}`)
  }

  const expiresAt = new Date(Date.now() + 10 * 60 * 1000 + 8 * 3600_000)
    .toISOString().replace('T', ' ').substring(0, 19)

  await sendSms(phone, templateCode, { code })

  await queryRun(
    'INSERT INTO verification_codes (phone, code, purpose, expires_at) VALUES (?, ?, ?, ?)',
    [phone, code, purpose, expiresAt]
  )

  return { code, expiresAt }
}
