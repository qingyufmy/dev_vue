import {test} from 'node:test'
import assert from 'node:assert/strict'
import {loadCombinedExecutionWorkflowPlan} from './execution-workflow-combined-plan.mjs'
import {coordinateInplaceSchema} from './inplace-schema-coordinator.mjs'
const plan=await loadCombinedExecutionWorkflowPlan(new URL('../../',import.meta.url))
test('205 to 238 chain resumes after every persisted DDL and replays the final schema',async()=>{
 const time='2026-09-10T00:00:00Z'
 const history=plan.steps.slice(0,205).map(step=>({id:step.id,checksum:step.checksum,status:'completed',startedAt:time,completedAt:time}))
 let state=plan.added[0].beforeHash,executions=0
 const store={async history(){return history},async tableHash(){return state},
  async begin(step){history.push({id:step.id,checksum:step.checksum,status:'started',startedAt:time,completedAt:null})},
  async execute(sql){const step=plan.added.find(row=>row.sql===sql);assert.ok(step);assert.equal(state,step.beforeHash);state=step.afterHash;executions++;throw Error('ack_lost')},
  async complete(step){const row=history.find(row=>row.id===step.id);row.status='completed';row.completedAt=time}}
 for(let index=0;index<33;index++)await assert.rejects(coordinateInplaceSchema(store,plan,{apply:true}),/ack_lost/)
 assert.ok((await coordinateInplaceSchema(store,plan,{apply:true})).structureComplete)
 assert.ok((await coordinateInplaceSchema(store,plan,{apply:true})).structureComplete)
 assert.equal(executions,33);assert.equal(history.length,238);assert.equal(state,plan.finalSchemaHash)
})
