import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { settingsValueContracts, inspectSettingValue } from '../scripts/lib/v4-settings-value-contract.mjs'
it('covers every reviewed global candidate and excludes user preferences and legacy reviews', () => {
  const inventory = JSON.parse(readFileSync(new URL('../docs/migration/dev-vue-settings-disposition-20260907.json', import.meta.url)))
  const candidates = inventory.entries.filter(x => x.disposition === 'system_setting_review').map(x => `${x.category}/${x.key}`).sort()
  expect(settingsValueContracts().map(x => `${x.namespace}/${x.key}`).sort()).toEqual(candidates)
  expect(() => inspectSettingValue('quote_symbol', 'quote_symbol_23', 'XAUUSD')).toThrow('unknown')
})
it('does not coerce boolean, integer, missing or empty legacy representations', () => {
  for (const value of ['1', 'TRUE', ' true ', '', null]) expect(inspectSettingValue('smtp','secure',value).compatible).toBe(false)
  for (const value of ['0','65536','0587','587.0',' 587',null]) expect(inspectSettingValue('smtp','port',value).compatible).toBe(false)
  expect(inspectSettingValue('smtp','port','587').compatible).toBe(true)
  expect(inspectSettingValue('qiniu','region','cn-south').compatible).toBe(true)
})
it('distinguishes JSON array syntax from semantic acceptance and opaque secret shape from custody', () => {
  expect(inspectSettingValue('toolbox','items','[]')).toMatchObject({ compatible: true, semanticAcceptanceVerified: false, needs: ['item_schema_review'] })
  expect(inspectSettingValue('toolbox','items','{}').compatible).toBe(false)
  expect(inspectSettingValue('smtp','pass','plain')).toMatchObject({ compatible: false, exposure: 'secret' })
  const value = JSON.stringify({ v:'1',ct:'opaque',iv:'opaque',tag:'opaque' })
  const result = inspectSettingValue('smtp','pass',value)
  expect(result).toMatchObject({ compatible: true, semanticAcceptanceVerified: false, needs: ['keyring_restore_and_decryption_proof'] })
  expect(JSON.stringify(result)).not.toContain('opaque')
})
it('returns copies of rules and never repairs invalid strings silently', () => {
  settingsValueContracts()[0].type = 'changed'
  expect(settingsValueContracts()[0].type).toBe('boolean')
  expect(inspectSettingValue('smtp','host','\ud800').compatible).toBe(false)
  expect(inspectSettingValue('crypto_wallet','fixed_tron_address','')).toMatchObject({ valueKind: 'empty', needs: ['chain_address_validation'] })
})
