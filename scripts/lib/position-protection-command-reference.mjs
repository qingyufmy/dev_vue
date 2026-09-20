import assert from 'node:assert/strict'
import {createMysqlPositionProtectionCommandReviewer} from '../../server/dist-v4/modules/execution/composition.js'
import {sha256Canonical} from '../../server/dist-v4/modules/execution/domain/execution.js'

export async function verifyPositionProtectionCommandReview(pool,scope) {
 const db=await pool.getConnection(),checks=[]
 try {
  const [[identity]]=await db.query('SELECT DATABASE() db');assert.match(identity.db,/^dev_vue_protection_ref_[a-f0-9]{32}$/)
  await db.beginTransaction()
  const [[receipt]]=await db.execute('SELECT child_intent_id,child_json,review_json FROM position_protection_reviews_v4 WHERE workflow_id=?',[scope.workflowId])
  const child=typeof receipt.child_json==='string'?JSON.parse(receipt.child_json):receipt.child_json,originalHash=sha256Canonical(child)
  let mode='approved',calls=0
  const clock={async now(){const [[row]]=await db.query('SELECT UNIX_TIMESTAMP(UTC_TIMESTAMP(3))*1000 at');return new Date(Number(row.at))}}
  const current={async review(request){
   calls++;assert.deepEqual(request,child.request)
   const review=structuredClone(child.review);review.contextHash='d'.repeat(64);review.evaluation.evaluatedAt=(await clock.now()).toISOString()
   review.evaluation.approvedActions[0].expectedState.positionsRevision++;review.evaluation.approvedActions[0].expectedState.quoteRevision++
   if(mode==='price')review.evaluation.approvedActions[0].parameters.stop_loss='1'
   if(mode==='rejected'){review.evaluation.status='rejected';review.evaluation.rejectCode='RISK_GLOBAL_KILL_SWITCH';review.evaluation.approvedActions=[]}
   return review
  }}
  const reviewer=createMysqlPositionProtectionCommandReviewer(db,current,clock),fresh=await reviewer.review(scope,receipt.child_intent_id)
  assert.equal(fresh.childIntentId,receipt.child_intent_id);assert.equal(fresh.expiresAt,child.intent.expiresAt)
  assert.equal(fresh.sourceRequestHash,child.intent.requestHash);assert.equal(fresh.preparationReviewHash,child.reviewHash)
  assert.equal(fresh.action.expectedState.positionsRevision,child.intent.action.expectedState.positionsRevision+1)
  checks.push('actual-source-locks-and-current-review-preserve-original-child-with-new-authority')
  await assert.rejects(()=>reviewer.review(scope,'33333333-3333-5333-a333-333333333333'),/child_mismatch/)
  assert.equal(calls,1);checks.push('wrong-child-rejected-before-current-risk')
  for(const value of ['price','rejected']){mode=value;await assert.rejects(()=>reviewer.review(scope,receipt.child_intent_id),/command_review_invalid/)}
  mode='approved';checks.push('altered-protection-and-current-risk-rejection-cannot-authorize-command')
  await db.query('SAVEPOINT uncertain_child')
  await db.execute("UPDATE execution_intents SET status='uncertain' WHERE id=?",[receipt.child_intent_id])
  const before=calls;await assert.rejects(()=>reviewer.review(scope,receipt.child_intent_id),/child_not_prepared/);assert.equal(calls,before)
  await db.query('ROLLBACK TO SAVEPOINT uncertain_child');await db.query('RELEASE SAVEPOINT uncertain_child')
  checks.push('uncertain-child-cannot-be-reprepared-or-reissued')
  await db.query('SAVEPOINT uncertain_parent')
  await db.execute("UPDATE bridge_commands_v4 SET status='uncertain' WHERE id=(SELECT parent_command_id FROM partial_close_workflows_v4 WHERE id=?)",[scope.workflowId])
  const beforeParent=calls;await assert.rejects(()=>reviewer.review(scope,receipt.child_intent_id),/parent_not_confirmed/);assert.equal(calls,beforeParent)
  await db.query('ROLLBACK TO SAVEPOINT uncertain_parent');await db.query('RELEASE SAVEPOINT uncertain_parent')
  checks.push('parent-must-remain-confirmed-at-command-review-not-only-at-original-preparation')

  const [[after]]=await db.execute('SELECT child_json FROM position_protection_reviews_v4 WHERE workflow_id=?',[scope.workflowId])
  assert.equal(sha256Canonical(typeof after.child_json==='string'?JSON.parse(after.child_json):after.child_json),originalHash)
  checks.push('source-receipt-remains-immutable')
  return {passed:true,checks,currentRisk:'injected-port',authorityPersisted:false,bridgeCommandCreated:false}
 }finally{await db.rollback();db.release()}
}
