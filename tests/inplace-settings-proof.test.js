import { expect, it } from 'vitest'
import { verifySettingsProof, verifySettingsUpgradeRows } from '../scripts/lib/inplace-settings-proof.mjs'
it('binds the actual three-fault restored database proof and all its files', async () => {
  expect(await verifySettingsProof(new URL('../',import.meta.url))).toMatchObject({files:186,faultRecovered:true})
})
it('allows an absent table to become empty but rejects lost or changed rows', () => {
  const absent={system_settings:null,system_setting_changes:null}
  const empty={system_settings:{rows:0,sha256:'a'},system_setting_changes:{rows:0,sha256:'b'}}
  expect(()=>verifySettingsUpgradeRows(absent,empty)).not.toThrow()
  expect(()=>verifySettingsUpgradeRows(empty,structuredClone(empty))).not.toThrow()
  expect(()=>verifySettingsUpgradeRows(absent,{...empty,system_settings:{rows:1}})).toThrow('not_empty')
  expect(()=>verifySettingsUpgradeRows(empty,absent)).toThrow('rows_changed')
  expect(()=>verifySettingsUpgradeRows(empty,{...empty,system_settings:{rows:0,sha256:'changed'}})).toThrow('rows_changed')
})
