import assert from 'node:assert/strict'
import {it} from 'node:test'
import {loadReconciliationIndexUpgrade} from './reconciliation-index-upgrade.mjs'

it('appends the evidenced index without changing any completed step or unrelated table',async()=>{
 const plan=await loadReconciliationIndexUpgrade(new URL('../../',import.meta.url))
 assert.equal(plan.steps.length,239)
 assert.deepEqual(plan.steps.slice(0,238),plan.prior.steps)
 assert.equal(Object.keys(plan.finalTableHashes).length,293)
 assert.deepEqual(Object.keys(plan.finalTableHashes).filter(name=>plan.finalTableHashes[name]!==plan.prior.finalTableHashes[name]),['outbox_events'])
 assert.equal(plan.step.beforeHash,plan.prior.finalSchemaHash)
 assert.equal(plan.step.afterHash,plan.finalSchemaHash)
 assert.ok(plan.step.sql.includes('ADD INDEX idx_outbox_aggregate_event'))
})
