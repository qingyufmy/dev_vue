import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {writePartialCloseParentDispatchReview} from '../../server/dist-v4/modules/execution/infrastructure/mysql-partial-close-parent-dispatch-review.js'
import {buildPartialClosePlan} from '../../server/dist-v4/modules/execution/domain/partial-close-plan.js'
import {sha256Canonical} from '../../server/dist-v4/modules/execution/domain/execution.js'

export async function verifyPartialCloseParentDispatchReference(db,command,action) {
 const [[identity]]=await db.query('SELECT DATABASE() db');assert.match(identity.db,/^dev_vue_strategy_ref_[a-f0-9]{32}$/)
 const bytes=await readFile(new URL('../../server/db/migrations/inplace/066_partial_close_parent_dispatches.sql',import.meta.url))
 await db.query(bytes.toString('utf8'))
 const expires=Date.parse(command.deadlineAt),plan=buildPartialClosePlan(command,action,expires)
 const targets={async read(){return {target:structuredClone(plan.target),revision:plan.initialRevision,volume:plan.initialVolume}}}
 const reviewer={async review(request){
  const [[clock]]=await db.query('SELECT UNIX_TIMESTAMP(UTC_TIMESTAMP(3))*1000 at')
  return {status:'approved',rejectCode:null,requestHash:sha256Canonical(request),contextHash:'a'.repeat(64),policyHash:'b'.repeat(64),
   evaluatedAt:new Date(Number(clock.at)).toISOString(),volume:plan.closeVolume,remainingVolume:'0.02'}
 }}
 const count=async()=>{const [[row]]=await db.execute('SELECT COUNT(*) n FROM partial_close_parent_dispatches_v4 WHERE parent_command_id=?',[command.id]);return Number(row.n)}
 const write=connection=>writePartialCloseParentDispatchReview(connection,command,action,expires,targets,reviewer)
 const wrapped=new Proxy(db,{get(target,key){if(key==='execute')return async(sql,...args)=>{
  const result=await target.execute(sql,...args)
  if(sql.includes('INSERT INTO partial_close_parent_dispatches_v4'))throw Error('parent_dispatch_after_insert_fault')
  return result
 };const value=target[key];return typeof value==='function'?value.bind(target):value}})
 await db.beginTransaction()
 try{await assert.rejects(()=>write(wrapped),/parent_dispatch_after_insert_fault/)}finally{await db.rollback()}
 assert.equal(await count(),0)
 await db.beginTransaction()
 try{
  await db.execute("UPDATE partial_close_workflows_v4 SET plan_sha256=REPEAT('0',64) WHERE id=?",[plan.workflowId])
  await assert.rejects(()=>write(db),/partial_close_dispatch_registration_invalid/)
 }finally{await db.rollback()}
 assert.equal(await count(),0)
 await db.beginTransaction()
 try{await write(db);await db.commit()}catch(error){await db.rollback();throw error}
 assert.equal(await count(),1)
 const [[saved]]=await db.execute('SELECT command_revision,review_json,review_sha256 FROM partial_close_parent_dispatches_v4 WHERE parent_command_id=?',[command.id])
 const receipt=typeof saved.review_json==='string'?JSON.parse(saved.review_json):saved.review_json
 assert.equal(Number(saved.command_revision),2);assert.equal(sha256Canonical(receipt),saved.review_sha256)
 assert.equal(receipt.commandHash,command.requestHash);assert.equal(receipt.planHash,sha256Canonical(plan))
 await db.beginTransaction()
 try{await assert.rejects(()=>write(db),error=>error.code==='ER_DUP_ENTRY')}finally{await db.rollback()}
 assert.equal(await count(),1)
 await assert.rejects(()=>db.execute('UPDATE partial_close_parent_dispatches_v4 SET command_revision=3 WHERE parent_command_id=?',[command.id]),error=>error.code==='ER_CHECK_CONSTRAINT_VIOLATED')
 await assert.rejects(()=>db.execute("INSERT INTO partial_close_parent_dispatches_v4 VALUES ('missing-parent',2,JSON_OBJECT(),REPEAT('a',64),UTC_TIMESTAMP(3))"),error=>error.code==='ER_NO_REFERENCED_ROW_2')
 return {passed:true,checks:['actual-066-DDL','late-insert-fault-rolls-back-receipt','altered-plan-rejected-before-insert',
  'receipt-hash-binds-command-plan-and-current-review','duplicate-parent-receipt-rejected','revision-check-and-workflow-FK-enforced'],
  migrationSha256:createHash('sha256').update(bytes).digest('hex'),targetReader:'injected',riskReviewer:'injected',
  commandDispatchTransition:'not-exercised-receipt-writer-only',existingDatabaseWrites:0}
}
