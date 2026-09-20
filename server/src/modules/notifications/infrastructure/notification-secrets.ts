import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
function keys(): Record<string, string> { return JSON.parse(process.env.AI_CREDENTIAL_KEYS_JSON ?? '{}') }
export function seal(value: string) {
  const entry = Object.entries(keys())[0]
  if (!entry || Buffer.from(entry[1], 'base64').length !== 32) throw Error('notification_key_unavailable')
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(entry[1], 'base64'), iv)
  return JSON.stringify({ v: entry[0], iv: iv.toString('base64'), ct: Buffer.concat([cipher.update(value), cipher.final()]).toString('base64'), tag: cipher.getAuthTag().toString('base64') })
}
export function unseal(value: string) {
  const e = JSON.parse(value), key = keys()[e.v]
  if (!key) throw Error('notification_key_unavailable')
  const d = createDecipheriv('aes-256-gcm', Buffer.from(key, 'base64'), Buffer.from(e.iv, 'base64'))
  d.setAuthTag(Buffer.from(e.tag, 'base64'))
  return Buffer.concat([d.update(Buffer.from(e.ct, 'base64')), d.final()]).toString('utf8')
}
