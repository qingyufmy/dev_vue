import { expect, it } from 'vitest'
import { classifySettingsInventory } from '../scripts/lib/v4-settings-disposition.mjs'
const row = (category, key) => ({ id: '1', category, key, valueKind: 'text', valueBytes: '3', jsonValid: 0,
  sortOrder: null, createdAtRaw: null, updatedAtRaw: null, rowSha256: 'a'.repeat(64), sensitiveNameCandidate: false })
it('separates user preferences from system settings without asserting account ownership', () => {
  expect(classifySettingsInventory([row('quote_symbol', 'quote_symbol_23')])[0]).toMatchObject({ disposition: 'user_preference_review', ownerId: '23', deletionAuthorized: false })
  expect(() => classifySettingsInventory([row('quote_symbol', 'quote_symbol_0')])).toThrow()
})
it('keeps obsolete-looking values under review and does not automatically expose unknown keys', () => {
  for (const [category, key, disposition] of [['auth','enable_email_login','legacy_auth_consumer_review'], ['crypto_wallet','hd_mnemonic','environment_replacement_review'], ['crypto_wallet','rate_source','legacy_rate_consumer_review'], ['custom','unknown','system_setting_review']]) {
    expect(classifySettingsInventory([row(category, key)])[0]).toMatchObject({ disposition, exposure: 'restricted_until_reviewed', deletionAuthorized: false, valueTypeApproved: false })
  }
})
it('rejects raw configuration values and duplicate row identities', () => {
  const r = row('smtp', 'pass')
  expect(() => classifySettingsInventory([{ ...r, value: 'secret' }])).toThrow()
  expect(() => classifySettingsInventory([r, r])).toThrow()
})
