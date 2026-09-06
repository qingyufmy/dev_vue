import { expect, it } from 'vitest'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'
import { prepareSettingsRows } from '../scripts/lib/v4-settings-rows.mjs'
import { settingsFixture as fixture } from './fixtures/settings-fixture.mjs'
it('preserves all source fields and raw values with independent times and exact target columns',()=>{
  const f=fixture(),entry=f.convert().entries[0]
  expect(entry.provenance.source).toEqual(f.row)
  expect(Object.keys(entry.target)).toHaveLength(15)
  expect(entry.target).toMatchObject({value_text:'false',value_type:'boolean',sensitivity:'restricted',created_at_utc:'2025-12-31 17:00:00.000',updated_at_utc:null,sort_order:null})
})
it('rejects missing semantic evidence, time assumptions and changed raw values',()=>{
  for(const mutate of [f=>f.options.evidenceCatalog.clear(),f=>f.options.basis.resolutions[0].valueEvidence.requirements=[],f=>f.options.basis.resolutions[0].createdAt.offsetMinutes=null,f=>f.options.basis.resolutions[0].updatedAt.raw='2026-01-01 00:00:00',f=>f.row.value='true']) {
    const f=fixture();mutate(f);expect(()=>f.convert()).toThrow()
  }
})
it('does not infer types for unknown or user-scoped configuration',()=>{
  const f=fixture();f.row.category='quote_symbol';f.row.key='quote_symbol_1'
  f.options.basis.sourceHash=hash([f.row]);f.options.basis.resolutions[0].sourceHash=hash(f.row)
  expect(()=>f.convert()).toThrow('settings_contract_unknown')
})
it('requires credential recovery evidence and preserves ciphertext without returning it in diagnostics',()=>{
  const f=fixture();f.row.key='pass';f.row.value=JSON.stringify({v:'1',iv:'opaque',ct:'opaque',tag:'opaque'})
  f.options.basis.sourceHash=hash([f.row]);f.options.basis.resolutions[0].sourceHash=hash(f.row)
  expect(()=>f.convert()).toThrow('settings_semantic_scope')
  f.options.basis.resolutions[0].valueEvidence.requirements.push('keyring_restore_and_decryption_proof')
  const result=f.convert();expect(result.valuesDecrypted).toBe(false)
  expect(result.entries[0].target).toMatchObject({sensitivity:'secret',value_text:f.row.value})
})
