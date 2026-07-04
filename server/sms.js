import Dysmsapi from '@alicloud/dysmsapi20170525'
import * as OpenApiClient from '@alicloud/openapi-client'
import { queryAll, queryRun, beijingNow } from './db.js'

let cachedConfig = null

export function resetSmsConfig() {
  cachedConfig = null
}

export async function loadSmsConfig() {
  if (cachedConfig) return cachedConfig

  const rows = await queryAll(
    "SELECT `key`, value FROM system_config WHERE category = 'sms'"
  )

  if (!rows.length) {
    throw new Error('[SMS] No sms config found in system_config')
  }

  const map = Object.fromEntries(rows.map(r => [r.key, r.value]))

  cachedConfig = {
    accessKeyId: map.accessKeyId || '',
    accessKeySecret: map.accessKeySecret || '',
    signName: map.signName || '',
    templateCodes: JSON.parse(map.templateCodes || '{}'),
  }

  return cachedConfig
}

export async function sendSms(phone, templateCode, templateParams = {}) {
  const cfg = await loadSmsConfig()

  const client = new OpenApiClient.default({
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

  const now = new Date()
  const expiresMs = now.getTime() + 10 * 60 * 1000
  const expires = new Date(expiresMs + 8 * 3600_000)
    .toISOString()
    .replace('T', ' ')
    .substring(0, 19)

  await queryRun(
    'INSERT INTO verification_codes (email, phone, code, purpose, expires_at) VALUES (?, ?, ?, ?, ?)',
    [phone, phone, code, purpose, expires]
  )

  await sendSms(phone, templateCode, { code })

  return { code, expires }
}
