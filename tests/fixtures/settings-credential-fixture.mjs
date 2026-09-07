import { settingsFixture } from './settings-fixture.mjs'
import { hash } from '../../scripts/lib/v4-backfill-contract.mjs'
import { prepareCredentialPlan } from '../../scripts/lib/v4-settings-credential-plan.mjs'
export function settingsCredentialFixture() {
  const f=settingsFixture()
  f.row.category='qiniu';f.row.key='secret_key';f.row.value='fixture-private-original'
  f.options.basis.version='settings-credential-import/v1'
  f.options.basis.sourceHash=hash([f.row])
  const resolution=f.options.basis.resolutions[0]
  resolution.sourceHash=hash(f.row);resolution.sourceFormat='plaintext'
  resolution.valueEvidence.requirements=['semantic_review','credential_plan_authenticated']
  f.options.credentialKeyring=new Map([['v1',Buffer.alloc(32,17)]])
  f.options.credentialPlan=prepareCredentialPlan([{sourceId:f.row.id,namespace:f.row.category,key:f.row.key,
    sourceRowHash:hash(f.row),sourceFormat:'plaintext',value:f.row.value}],
    {runId:f.options.run.id,snapshotHash:hash([f.row])},{keyring:f.options.credentialKeyring,activeVersion:'v1'})
  f.options.expectedPlanChecksum=f.options.credentialPlan.checksum
  return f
}
