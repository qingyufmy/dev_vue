import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {loadQuoteProvenanceUpgrade} from './quote-provenance-upgrade.mjs'
import {planInferenceRootPromotion} from './inference-root-promotion.mjs'
import {inferenceRootSchemaState} from './inference-root-schema-state.mjs'
import {hash} from './v4-backfill-contract.mjs'
import {sha256,splitSqlStatements} from './v4-migration-plan.mjs'

export async function loadInferenceRootUpgrade(root){
 const prior=await loadQuoteProvenanceUpgrade(root)
 assert.equal(prior.steps.length,205)
 const readJson=async path=>JSON.parse(await readFile(new URL(path,root),'utf8'))
 const inventory=await readJson('docs/architecture/execution-upgrade-source-inventory-v2-20260910.json')
 const candidate=planInferenceRootPromotion(inventory,prior.prior.finalTableHashes)
 const reference=(await readJson('docs/architecture/strategy-write-reference-v150-20260910.json')).inferenceRootFullSchema
 assert.ok(reference.passed && reference.referenceDatabaseRemoved && reference.existingDatabaseWrites===0)
 assert.equal(reference.sourceTableCount,270);assert.equal(reference.promotionSql,candidate.sql)
 const rehearsal=await readJson('docs/architecture/inference-root-restored-v1-20260910.json')
 const baseline=await readJson('docs/architecture/inference-root-restored-v1-20260910.json.baseline.json')
 assert.ok(rehearsal.passed && rehearsal.currentDevVueWrites===0 && rehearsal.ddlAttempted===2)
 assert.equal(rehearsal.baselineHash,hash(baseline));assert.equal(rehearsal.planHash,hash(candidate))
 assert.equal(baseline.target,'dev_vue_m1_source_20260910_02')
 const before=inferenceRootSchemaState(baseline.before),after=inferenceRootSchemaState(baseline.before,candidate.renames)
 assert.equal(before.sha256,reference.beforeSchemaHash);assert.equal(after.sha256,reference.afterSchemaHash)
 const source='server/db/migrations/inplace/063_inference_root_promotion.sql',bytes=await readFile(new URL(source,root))
 assert.deepEqual(splitSqlStatements(bytes.toString('utf8')),[candidate.sql])
 const body={id:'inplace_063_01_inference_root_promotion',table:'inference_root_schema',protocol:'inference-root-promotion/v1',
  sql:candidate.sql,source,sourceSha256:sha256(bytes),beforeHash:before.sha256,afterHash:after.sha256,
  priorRegistryHash:hash(prior.steps.map(({id,checksum})=>({id,checksum}))),referenceHash:hash(reference),rehearsalHash:hash(rehearsal)}
 const step={...body,checksum:hash(body)}
 return {prior,step,steps:[...prior.steps,step],transitions:[{step,key:step.table,before:before.sha256,after:after.sha256}],candidate}
}
