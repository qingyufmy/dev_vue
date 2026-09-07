import { describe, expect, it } from 'vitest'
import { createCipheriv } from 'node:crypto'
import { convertSettingCredential as convert } from '../scripts/lib/v4-settings-credential-conversion.mjs'

const keyring = new Map([['v1', Buffer.alloc(32, 7)], ['v2', Buffer.alloc(32, 8)]])
const options = { sourceFormat: 'plaintext', keyring, activeVersion: 'v2' }
function legacy(value) {
  const iv = Buffer.alloc(12, 3), cipher = createCipheriv('aes-256-gcm', keyring.get('v1'), iv)
  return JSON.stringify({ v: 'v1', iv: iv.toString('base64'), ct: Buffer.concat([cipher.update(value), cipher.final()]).toString('base64'), tag: cipher.getAuthTag().toString('base64') })
}
describe('settings credential conversion', () => {
  it('preserves unconfigured state and rejects NULL or implicit format decisions', () => {
    expect(convert('', { sourceFormat: 'empty' }).state).toBe('not_configured')
    expect(() => convert(null, { sourceFormat: 'empty' })).toThrow('source_invalid')
    expect(() => convert('secret', {})).toThrow('source_format_required')
    expect(() => convert('', { sourceFormat: 'empty', existingTarget: 'configured' })).toThrow('empty_conflict')
  })
  it('protects exact Unicode/whitespace and reuses the durable target on retry', () => {
    const source = '  test-密钥\n', first = convert(source, options)
    expect(first).toMatchObject({ authenticated: true, reused: false, state: 'protected' })
    expect(first.value).not.toContain(source)
    expect(convert(source, { ...options, existingTarget: first.value })).toEqual({ ...first, reused: true })
    expect(convert(source, options).value).not.toBe(first.value)
    expect(() => convert(source.trim(), { ...options, existingTarget: first.value })).toThrow('target_conflict')
  })
  it('authenticates legacy envelopes and preserves their exact serialized bytes', () => {
    const source = ` ${legacy('fixture-only')} `
    expect(convert(source, { sourceFormat: 'encrypted', keyring }).value).toBe(source)
    expect(() => convert(source, options)).toThrow('source_format_ambiguous')
    expect(() => convert('{broken', options)).toThrow('source_format_ambiguous')
  })
  it('rejects corrupted tags, unavailable keys and malformed encodings', () => {
    const source = JSON.parse(legacy('fixture-only'))
    expect(() => convert(JSON.stringify({ ...source, tag: Buffer.alloc(16).toString('base64') }), { sourceFormat: 'encrypted', keyring })).toThrow('authentication_failed')
    expect(() => convert(JSON.stringify(source), { sourceFormat: 'encrypted', keyring: new Map() })).toThrow('key_unavailable')
    for (const patch of [{ iv: source.iv + '\n' }, { iv: 'AAAA' }, { extra: 1 }, { ct: '' }]) {
      expect(() => convert(JSON.stringify({ ...source, ...patch }), { sourceFormat: 'encrypted', keyring })).toThrow('envelope_invalid')
    }
  })
  it('rejects oversized and invalid Unicode sources without exposing their contents', () => {
    for (const source of ['x'.repeat(16385), '\ud800']) {
      expect(() => convert(source, options)).toThrow('settings_credential_source_invalid')
    }
  })
})
