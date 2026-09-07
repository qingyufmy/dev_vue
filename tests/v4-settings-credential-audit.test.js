import { restoreCredentialSource } from '../scripts/lib/v4-settings-credential-source.mjs'
import { expect,it } from 'vitest'
import { hash,streamIdentity } from '../scripts/lib/v4-backfill-contract.mjs'
import { settingsCredentialFixture } from './fixtures/settings-credential-fixture.mjs'
import { createCredentialSettingsBackfill } from '../scripts/lib/v4-settings-credential-backfill.mjs'
import { auditCredentialSettingsImport } from '../scripts/lib/v4-settings-credential-audit.mjs'
function fixture(){const f=settingsCredentialFixture(),p=createCredentialSettingsBackfill([f.row],f.options),entry=p.batches[0].rows[0]
 const actual=[structuredClone(entry.payload.entry.target)],archives=[{sourceId:f.row.id,runId:p.runId,sourceHash:hash(f.row),sourcePkHash:hash(entry.pk),payload:p.sourceEvidence(streamIdentity(p.stream),entry)}]
 return {...f,actual,archives,audit(){return auditCredentialSettingsImport([this.row],this.actual,this.archives,this.options)}}}
it('independently verifies all fifteen target fields and original eight-field archive',()=>{expect(fixture().audit().importMatchesReviewedInputs).toBe(true)})
it('detects each target field change without printing values',()=>{for(const field of Object.keys(fixture().actual[0])){const f=fixture();f.actual[0][field]=field.endsWith('_at_utc')?'2000-01-01 00:00:00.000':'changed';expect(f.audit().importMatchesReviewedInputs).toBe(false)}})
it('detects changed archived fields even with recomputed source hashes',()=>{for(const field of Object.keys(fixture().row)){const f=fixture();f.archives[0].payload.source[field]='changed';f.archives[0].sourceHash=hash(f.archives[0].payload.source);expect(f.audit().importMatchesReviewedInputs).toBe(false)}})
it('rejects missing evidence and detects missing, duplicate or extra rows',()=>{
 const f=fixture();f.options.evidenceCatalog.clear();expect(()=>f.audit()).toThrow('evidence')
 const g=fixture();g.actual=[];expect(g.audit().importMatchesReviewedInputs).toBe(false)
 const h=fixture();h.archives.push(h.archives[0]);expect(()=>h.audit()).toThrow('duplicate')
 const i=fixture();i.actual.push({...i.actual[0],id:'2'});expect(i.audit().differences).toContainEqual({sourceId:'2',field:'target',code:'unexpected'})
})

it('rejects a different frozen plan and detects changed source encoding',()=>{
 const f=fixture();f.options.expectedPlanChecksum='a'.repeat(64);expect(()=>f.audit()).toThrow('credential_plan')
 const g=fixture();g.archives[0].payload.sourceValueEncoding='plaintext';expect(g.audit().importMatchesReviewedInputs).toBe(false)
})

it('restores the exact original row from protected source evidence alone',()=>{
 const f=fixture(),payload=f.archives[0].payload
 expect(restoreCredentialSource(payload,{sourceHash:hash(f.row),keyring:f.options.credentialKeyring})).toEqual(f.row)
 expect(()=>restoreCredentialSource(payload,{sourceHash:hash(f.row),keyring:new Map()})).toThrow('recovery_failed')
 const changed=structuredClone(payload);changed.source.label='changed'
 expect(()=>restoreCredentialSource(changed,{sourceHash:hash(f.row),keyring:f.options.credentialKeyring})).toThrow('source_hash')
})
