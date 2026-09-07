import { expect, it } from 'vitest'
import { verifySettingRequestProof, verifySettingRequestUpgradeRows } from '../scripts/lib/inplace-setting-request-proof.mjs'
it('binds the actual one-fault restored database proof and all its files', async () => {
  expect(await verifySettingRequestProof(new URL('../',import.meta.url))).toMatchObject({files:192,faultRecovered:true})
})
it('allows an absent table to become empty but rejects lost or changed rows', () => {
  const absent={system_setting_requests:null}
  const empty={system_setting_requests:{rows:0,sha256:'a'}}
  expect(()=>verifySettingRequestUpgradeRows(absent,empty)).not.toThrow()
  expect(()=>verifySettingRequestUpgradeRows(empty,structuredClone(empty))).not.toThrow()
  expect(()=>verifySettingRequestUpgradeRows(absent,{...empty,system_setting_requests:{rows:1}})).toThrow('not_empty')
  expect(()=>verifySettingRequestUpgradeRows(empty,absent)).toThrow('rows_changed')
  expect(()=>verifySettingRequestUpgradeRows(empty,{...empty,system_setting_requests:{rows:0,sha256:'changed'}})).toThrow('rows_changed')
})
