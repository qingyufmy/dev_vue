import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { loadMemoryRuntimeAuditUpgrade, memoryRuntimeAuditPlan } from './memory-runtime-audit-upgrade.mjs'
import { coordinateInplaceSchema } from './inplace-schema-coordinator.mjs'
const root=new URL('../../',import.meta.url),plan=await loadMemoryRuntimeAuditUpgrade(root)
function fixture(fault){
  const rows=plan.prior.steps.map(s=>({id:s.id,checksum:s.checksum,status:'completed',startedAt:'2026-09-10T00:00:00.000Z',completedAt:'2026-09-10T00:00:01.000Z'}))
  let schema=plan.added[0].beforeHash,ddls=0,armed=true
  const crash=kind=>{if(armed&&fault===kind){armed=false;throw Error('injected_ack_loss')}}
  return {rows,get ddls(){return ddls},set schema(value){schema=value},store:{
    async history(){return structuredClone(rows)},async tableHash(){return schema},
    async begin(s){rows.push({id:s.id,checksum:s.checksum,status:'started',startedAt:'2026-09-10T00:00:02.000Z',completedAt:null});crash('begin')},
    async execute(sql){assert.equal(sql,plan.added[0].sql);ddls++;schema=plan.added[0].afterHash;crash('ddl')},
    async complete(s){const row=rows.find(r=>r.id===s.id);row.status='completed';row.completedAt='2026-09-10T00:00:03.000Z';crash('complete')}
  }}
}
test('appends one reviewed transition without changing the 191 prior checksums',()=>{
  assert.equal(plan.steps.length,192);assert.deepEqual(plan.steps.slice(0,191),plan.prior.steps)
  assert.equal(plan.added[0].operation,'ALTER');assert.equal(Object.keys(plan.parentHashes).length,6)
})
for(const fault of ['begin','ddl','complete'])test(`recovers ${fault} acknowledgement loss with exactly one DDL`,async()=>{
  const f=fixture(fault)
  await assert.rejects(coordinateInplaceSchema(f.store,plan,{apply:true}),/injected_ack_loss/)
  const result=await coordinateInplaceSchema(f.store,plan,{apply:true})
  assert.equal(result.structureComplete,true);assert.equal(f.ddls,1)
  await coordinateInplaceSchema(f.store,plan,{apply:true});assert.equal(f.ddls,1)
  assert.equal(f.rows.length,192)
})
test('dry run makes no journal or DDL writes',async()=>{
  const f=fixture(),result=await coordinateInplaceSchema(f.store,plan)
  assert.equal(result.steps[0].status,'pending');assert.equal(f.ddls,0);assert.equal(f.rows.length,191)
})
test('rejects unexpected source schema before journal writes',async()=>{
  const f=fixture();f.schema='f'.repeat(64)
  await assert.rejects(coordinateInplaceSchema(f.store,plan,{apply:true}),/schema_conflict/)
  assert.equal(f.ddls,0);assert.equal(f.rows.length,191)
})
test('rejects a changed migration source or changed parent proof',async()=>{
  const report=JSON.parse(await readFile(new URL('docs/architecture/strategy-write-reference-v59-20260910.json',root),'utf8'))
  const inventory=JSON.parse(await readFile(new URL('docs/architecture/memory-upgrade-current-inventory-v2-20260910.json',root),'utf8'))
  const bytes=await readFile(new URL(plan.added[0].source,root))
  assert.throws(()=>memoryRuntimeAuditPlan(plan.prior,report,inventory,Buffer.concat([bytes,Buffer.from(' ')])))
  inventory.tables.inference_snapshots.definitionHash='f'.repeat(64)
  assert.throws(()=>memoryRuntimeAuditPlan(plan.prior,report,inventory,bytes))
})
