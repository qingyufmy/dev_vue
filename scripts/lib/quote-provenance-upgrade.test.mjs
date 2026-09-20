import assert from 'node:assert/strict'
import test from 'node:test'
import {loadQuoteProvenanceUpgrade,coordinateQuoteProvenanceUpgrade} from './quote-provenance-upgrade.mjs'
const plan=await loadQuoteProvenanceUpgrade(new URL('../../',import.meta.url))
const stamp='2026-09-10T10:00:00.000Z'
function fixture(loss) {
  let tableHash=plan.step.beforeHash,ddl=0,corrupt=false
  const history=plan.prior.steps.map(step=>({id:step.id,checksum:step.checksum,status:'completed',startedAt:stamp,completedAt:stamp}))
  const checks=[]
  const store={
    async verifyPlan(input){assert.equal(input.step.checksum,plan.step.checksum);checks.push('plan')},
    async verifyPrior(rows){assert.equal(rows.length,204);checks.push('prior')},
    async verifyProtected(){assert.equal(corrupt,false,'protected_changed');checks.push('data')},
    async history(){return structuredClone(history)},async tableHash(){return tableHash},
    async begin(step){history.push({id:step.id,checksum:step.checksum,status:'started',startedAt:stamp,completedAt:null});if(loss==='begin')throw Error('ack_lost')},
    async execute(){ddl++;tableHash=plan.step.afterHash;if(loss==='ddl')throw Error('ack_lost')},
    async complete(){const row=history.at(-1);row.status='completed';row.completedAt=stamp;if(loss==='complete')throw Error('ack_lost')},
  }
  return {store,history,checks,get ddl(){return ddl},setHash:value=>{tableHash=value},corrupt:()=>{corrupt=true}}
}
test('quote upgrade binds current 204 history, reviewed SQL and actual canonical before/after hashes',()=>{
  assert.equal(plan.steps.length,205);assert.equal(plan.transitions.length,1);assert.notEqual(plan.step.beforeHash,plan.step.afterHash)
  assert.equal(plan.steps.some(step=>step.id.startsWith('inplace_056')),false)
})
test('inspection writes nothing, apply executes once, replay does not alter again',async()=>{
  const f=fixture();assert.equal((await coordinateQuoteProvenanceUpgrade(f.store,plan)).steps[0].status,'pending');assert.equal(f.ddl,0)
  assert.equal((await coordinateQuoteProvenanceUpgrade(f.store,plan,{apply:true})).structureComplete,true);assert.equal(f.ddl,1)
  await coordinateQuoteProvenanceUpgrade(f.store,plan,{apply:true});assert.equal(f.ddl,1);assert.equal(f.history.length,205)
})
for(const stage of ['begin','ddl','complete'])test('recovers '+stage+' acknowledgment loss from durable state',async()=>{
  const f=fixture(stage);await assert.rejects(()=>coordinateQuoteProvenanceUpgrade(f.store,plan,{apply:true}),/ack_lost/)
  const status=(await coordinateQuoteProvenanceUpgrade(f.store,plan)).steps[0].status
  assert.equal(status,stage==='begin'?'pending':stage==='ddl'?'reconcile':'completed')
  if(stage==='begin')f.store.begin=async()=>assert.fail('must not begin again')
  let resumedDdl=0
  f.store.execute=async()=>{resumedDdl++;f.setHash(plan.step.afterHash)}
  f.store.complete=async()=>{Object.assign(f.history.at(-1),{status:'completed',completedAt:stamp})}
  await coordinateQuoteProvenanceUpgrade(f.store,plan,{apply:true});assert.equal(f.history.at(-1).status,'completed')
  assert.equal(f.ddl,stage==='begin'?0:1);assert.equal(resumedDdl,stage==='begin'?1:0)
})
test('never adopts an unjournaled upgraded table or an unexpected schema',async()=>{
  for(const hash of [plan.step.afterHash,'bad']) {
    const f=fixture();f.setHash(hash);await assert.rejects(()=>coordinateQuoteProvenanceUpgrade(f.store,plan,{apply:true}),/schema_conflict/);assert.equal(f.history.length,204)
  }
})
test('refuses unfinished prior history, changed checksums and protected data before DDL',async()=>{
  for(const issue of ['unfinished','checksum','protected']){
    const f=fixture()
    if(issue==='unfinished')Object.assign(f.history.at(-1),{status:'started',completedAt:null})
    if(issue==='checksum')f.history[0].checksum='changed'
    if(issue==='protected')f.corrupt()
    await assert.rejects(()=>coordinateQuoteProvenanceUpgrade(f.store,plan,{apply:true}));assert.equal(f.ddl,0);assert.equal(f.history.length,204)
  }
})
