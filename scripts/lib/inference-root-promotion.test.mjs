import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {planInferenceRootPromotion} from './inference-root-promotion.mjs'
import {loadInferenceBuildUpgrade} from './inference-build-upgrade.mjs'

const root=new URL('../../',import.meta.url)
const inventory=JSON.parse(await readFile(new URL('docs/architecture/execution-upgrade-source-inventory-v2-20260910.json',root)))
const {finalTableHashes}=await loadInferenceBuildUpgrade(root)
test('retains both populated legacy roots and their incoming FK evidence',()=>{
 const plan=planInferenceRootPromotion(inventory,finalTableHashes)
 assert.deepEqual(plan.retained.map(({from,rows})=>[from,rows]),[['inference_snapshots','789'],['ai_model_tasks','9317']])
 assert.equal(plan.retained.find(row=>row.from==='ai_model_tasks').incomingForeignKeys.length,3)
 assert.equal(plan.renames.length,14)
 assert.equal(plan.executed,false);assert.equal(plan.runtimeReady,false)
})
test('rejects an occupied preservation name',()=>{
 const changed=structuredClone(inventory);changed.tables.ai_model_tasks_legacy_v3={exists:true}
 assert.throws(()=>planInferenceRootPromotion(changed,finalTableHashes),/legacy_occupied/)
})
test('rejects populated build tables instead of silently promoting them',()=>{
 const changed=structuredClone(inventory);changed.tables.ai_model_tasks_v4_build.rows='1'
 assert.throws(()=>planInferenceRootPromotion(changed,finalTableHashes),/build_has_data/)
})
test('rejects build schema drift against the frozen applied migration',()=>{
 assert.throws(()=>planInferenceRootPromotion(inventory,{...finalTableHashes,inference_snapshots_v4_build:'0'.repeat(64)}),/schema_drift/)
})
