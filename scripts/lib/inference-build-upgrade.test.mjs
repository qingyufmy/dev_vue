import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadInferenceBuildUpgrade } from './inference-build-upgrade.mjs'
import { inferenceBuildDefinition,assertInferenceBuildParents } from './inference-build-schema.mjs'
import { coordinateInplaceSchema } from './inplace-schema-coordinator.mjs'
import { readFile } from 'node:fs/promises'
const root=new URL('../../',import.meta.url),plan=await loadInferenceBuildUpgrade(root)
test('registers 12 creates and the deferred cyclic FK after the unchanged 191 steps',()=>{
  assert.equal(plan.steps.length,204);assert.equal(plan.added.length,13)
  assert.deepEqual(plan.steps.slice(0,191),plan.prior.steps)
  assert.equal(plan.added.filter(s=>s.beforeHash===null).length,12)
  assert.equal(plan.added.at(-1).table,'trade_decisions_v4_build')
  assert.match(plan.added.at(-1).sql,/REFERENCES `risk_decisions_v4_build`/)
})
test('rewrites table references but preserves literal, comment and column identifiers',()=>{
  const ddl="CREATE TABLE `ai_model_tasks` (\n  `ai_model_tasks` varchar(40) COMMENT 'REFERENCES `ai_model_tasks`',\n  CONSTRAINT `test_fk` FOREIGN KEY (`ai_model_tasks`) REFERENCES `inference_snapshots` (`id`)\n)"
  const value=inferenceBuildDefinition('ai_model_tasks',ddl)
  assert.match(value,/CREATE TABLE `ai_model_tasks_v4_build`/)
  assert.match(value,/REFERENCES `inference_snapshots_v4_build`/)
  assert.ok(value.includes("COMMENT 'REFERENCES `ai_model_tasks`'"));assert.ok(value.includes('FOREIGN KEY (`ai_model_tasks`)'))
})
test('rejects an unreviewed foreign parent',()=>{
  assert.throws(()=>inferenceBuildDefinition('ai_model_tasks','CREATE TABLE `ai_model_tasks` (\n CONSTRAINT `x` FOREIGN KEY (`id`) REFERENCES `unreviewed` (`id`)\n)'),/inference_build_parent_unreviewed/)
})
test('rejects actual parent type drift before exposing a build namespace',async()=>{
  const inventory=JSON.parse(await readFile(new URL('docs/architecture/inference-schema-current-inventory-v4-20260910.json',root),'utf8'))
  assertInferenceBuildParents(inventory,plan.parentRequirements)
  inventory.tables.strategy_subscriptions_v4_build.columns.find(c=>c.name==='id').type='int'
  assert.throws(()=>assertInferenceBuildParents(inventory,plan.parentRequirements),/inference_build_parent_incompatible/)
})
for(const fault of ['begin','ddl','complete'])test(`recovers ${fault} loss in a 13-step build without duplicate DDL`,async()=>{
  const rows=plan.prior.steps.map(s=>({id:s.id,checksum:s.checksum,status:'completed',startedAt:'2026-09-10T00:00:00Z',completedAt:'2026-09-10T00:00:01Z'}))
  const states=new Map(),executions=[];let armed=true
  const crash=(kind,s)=>{if(armed&&fault===kind&&s.id===plan.added[7].id){armed=false;throw Error('ack_loss')}}
  const store={async history(){return structuredClone(rows)},async tableHash(name){return states.get(name)??null},
    async begin(s){rows.push({id:s.id,checksum:s.checksum,status:'started',startedAt:'2026-09-10T00:00:02Z',completedAt:null});crash('begin',s)},
    async execute(sql){const s=plan.added.find(s=>s.sql===sql);assert.ok(s);executions.push(s.id);states.set(s.table,s.afterHash);crash('ddl',s)},
    async complete(s){const row=rows.find(r=>r.id===s.id);row.status='completed';row.completedAt='2026-09-10T00:00:03Z';crash('complete',s)}}
  await assert.rejects(coordinateInplaceSchema(store,plan,{apply:true}),/ack_loss/)
  assert.equal((await coordinateInplaceSchema(store,plan,{apply:true})).structureComplete,true)
  await coordinateInplaceSchema(store,plan,{apply:true})
  assert.equal(executions.length,13);assert.equal(new Set(executions).size,13);assert.equal(rows.length,204)
})
