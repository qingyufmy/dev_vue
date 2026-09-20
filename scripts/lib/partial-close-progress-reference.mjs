import assert from 'node:assert/strict'
import { createMysqlPartialCloseWorkflowProgress } from '../../server/dist-v4/modules/execution/composition.js'
import { sha256Canonical } from '../../server/dist-v4/modules/execution/domain/execution.js'

/** Actual candidate workflow/audit/outbox SQL; history and current position ports are controlled fixtures. */
export async function verifyPartialCloseProgressReference(db,pool) {
  const [[identity]]=await db.query('SELECT DATABASE() db')
  assert.match(identity.db,/^dev_vue_strategy_ref_[a-f0-9]{32}$/)
  const [[row]]=await db.query(`SELECT w.id,w.plan_json FROM partial_close_workflows_v4 w JOIN bridge_commands_v4 c ON c.id=w.parent_command_id
    WHERE c.terminal_instance_id='terminal_12345678' AND c.status='queued'`)
  assert.ok(row)
  const plan=typeof row.plan_json==='string'?JSON.parse(row.plan_json):row.plan_json
  const scope={workflowId:plan.workflowId,userId:7,accountId:'5'},checks=[]
  let historyMissing=false,projectionMissing=false,oldProjection=false,wrongVolume=false,corruptHistory=false,historyCalls=0,projectionCalls=0
  const state=async()=>{
    const [[workflow]]=await db.execute('SELECT status,revision FROM partial_close_workflows_v4 WHERE id=?',[scope.workflowId])
    const [[events]]=await db.execute('SELECT COUNT(*) n FROM partial_close_workflow_events_v4 WHERE workflow_id=?',[scope.workflowId])
    const [[outbox]]=await db.execute('SELECT COUNT(*) n FROM outbox_events WHERE aggregate_id=?',[scope.workflowId])
    return {status:workflow.status,revision:Number(workflow.revision),events:Number(events.n),outbox:Number(outbox.n)}
  }
  const pending={status:'awaiting_close',revision:1,events:1,outbox:0}
  const reset=async(parent='succeeded')=>{
    historyMissing=false;projectionMissing=false;oldProjection=false;wrongVolume=false;corruptHistory=false;historyCalls=0;projectionCalls=0
    await db.execute('DELETE FROM partial_close_workflow_events_v4 WHERE workflow_id=? AND revision>1',[scope.workflowId])
    await db.execute('DELETE FROM outbox_events WHERE aggregate_id=?',[scope.workflowId])
    await db.execute("UPDATE partial_close_workflows_v4 SET status='awaiting_close',revision=1 WHERE id=?",[scope.workflowId])
    await db.execute('UPDATE bridge_commands_v4 SET status=? WHERE id=?',[parent,plan.parentCommandId])
    await db.execute('UPDATE execution_intents SET status=? WHERE id=?',[parent==='queued'?'prepared':parent,plan.parentIntentId])
  }
  const make=({failAt=null,loseAck=false}={})=>{
    let discarded=0
    const wrapped=new Proxy(pool,{get(target,key){
      if(key==='getConnection')return async()=>{
        const c=await target.getConnection();await c.query("SET SESSION time_zone='+00:00'")
        return new Proxy(c,{get(client,method){
          if(method==='execute')return async(sql,...args)=>{
            if(failAt&&String(sql).includes(`INSERT INTO ${failAt}`))throw Error('injected_progress_write_failure')
            return client.execute(sql,...args)
          }
          if(method==='commit')return async()=>{await client.commit();if(loseAck){loseAck=false;throw Error('injected_progress_commit_ack_loss')}}
          if(method==='destroy')return()=>{discarded++;client.destroy()}
          const value=client[method];return typeof value==='function'?value.bind(client):value
        }})
      }
      const value=target[key];return typeof value==='function'?value.bind(target):value
    }})
    const capture=async actual=>{
      assert.equal(actual.accountId,scope.accountId)
      return connection=>({
        history:{async read(input){
          historyCalls++;assert.deepEqual(input,plan)
          if(historyMissing)return null
          const [[clock]]=await connection.query('SELECT UNIX_TIMESTAMP(UTC_TIMESTAMP(3))*1000 now_msc')
          const evidence={resultHash:'a'.repeat(64),orderTicket:'201',taskId:'history-task',receiptId:'history-receipt',completionHash:'b'.repeat(64),
            deals:[{ticket:'301',dealId:'deal',factHash:'c'.repeat(64),provenanceHashes:['d'.repeat(64)]}]}
          return {parentIntentId:plan.parentIntentId,parentCommandId:plan.parentCommandId,target:{...plan.target},closedVolume:'0.08',completedAt:Number(clock.now_msc)-10,
            evidence,evidenceHash:corruptHistory?'0'.repeat(64):sha256Canonical(evidence)}
        }},
        projection:{async read(input){
          projectionCalls++;assert.deepEqual(input,plan)
          if(projectionMissing)return null
          const [[clock]]=await connection.query('SELECT UNIX_TIMESTAMP(UTC_TIMESTAMP(3))*1000 now_msc')
          return {route:{userId:'7',accountId:'5',terminalInstanceId:plan.target.terminalInstanceId,brokerServer:'Broker',login:'42'},complete:true,
            revision:oldProjection?plan.initialRevision:plan.initialRevision+1,observedAt:Number(clock.now_msc),positions:[{target:{...plan.target},volume:wrongVolume?'0.03':'0.02'}]}
        }},
      })
    }
    return {progress:createMysqlPartialCloseWorkflowProgress(wrapped,capture,30000),discarded:()=>discarded}
  }
  const service=make().progress
  await reset()
  await assert.rejects(service.advance({...scope,userId:8}),{code:'partial_close_progress_not_found'})
  assert.equal(historyCalls,0)
  await db.execute('UPDATE bridge_commands_v4 SET user_id=8 WHERE id=?',[plan.parentCommandId])
  await assert.rejects(service.advance(scope),{code:'partial_close_progress_parent_mismatch'})
  await db.execute('UPDATE bridge_commands_v4 SET user_id=7 WHERE id=?',[plan.parentCommandId])
  await db.execute('UPDATE partial_close_workflows_v4 SET plan_sha256=? WHERE id=?',['0'.repeat(64),scope.workflowId])
  await assert.rejects(service.advance(scope),{code:'partial_close_progress_plan_corrupt'})
  await db.execute('UPDATE partial_close_workflows_v4 SET plan_sha256=? WHERE id=?',[sha256Canonical(plan),scope.workflowId])
  const [[firstEvent]]=await db.execute('SELECT payload_json,payload_sha256 FROM partial_close_workflow_events_v4 WHERE workflow_id=? AND revision=1',[scope.workflowId])
  await db.execute('DELETE FROM partial_close_workflow_events_v4 WHERE workflow_id=? AND revision=1',[scope.workflowId])
  await assert.rejects(service.advance(scope),{code:'partial_close_progress_audit_corrupt'})
  await db.execute("INSERT INTO partial_close_workflow_events_v4 VALUES (?,1,'registered',?,?,UTC_TIMESTAMP(3))",[scope.workflowId,typeof firstEvent.payload_json==='string'?firstEvent.payload_json:JSON.stringify(firstEvent.payload_json),firstEvent.payload_sha256])
  assert.deepEqual(await state(),pending)
  checks.push('wrong-owner-parent-scope-plan-hash-and-missing-registration-audit-rejected')
  await reset('queued')
  assert.equal((await service.advance(scope)).assessment.state,'wait_close')
  assert.equal(historyCalls,0);assert.deepEqual(await state(),pending)
  await reset('uncertain')
  assert.equal((await service.advance(scope)).assessment.state,'reconcile_close')
  assert.equal(historyCalls,0);assert.deepEqual(await state(),pending)
  checks.push('pending-and-uncertain-do-not-read-history-or-write-another-stage')
  for(const mode of ['missing-history','missing-projection','old-projection']){
    await reset();historyMissing=mode==='missing-history';projectionMissing=mode==='missing-projection';oldProjection=mode==='old-projection'
    const result=await service.advance(scope)
    assert.equal(result.assessment.state,historyMissing?'wait_history':'wait_projection')
    if(historyMissing)assert.equal(projectionCalls,0)
    assert.deepEqual(await state(),pending)
  }
  checks.push('missing-history-or-missing-or-old-complete-projection-remains-durable-waiting')
  await reset();corruptHistory=true
  await assert.rejects(service.advance(scope),{code:'partial_close_progress_history_corrupt'})
  assert.deepEqual(await state(),pending)
  checks.push('corrupt-history-evidence-hash-rolls-back-before-progress')
  for(const parent of ['failed','rejected']){
    await reset(parent)
    const result=await service.advance(scope)
    assert.equal(result.status,'stopped');assert.equal(result.assessment.reason,'close_not_completed')
    assert.equal(historyCalls,0)
    assert.deepEqual(await state(),{status:'stopped',revision:2,events:2,outbox:1})
  }
  await reset();wrongVolume=true
  assert.equal((await service.advance(scope)).assessment.reason,'remaining_volume_mismatch')
  checks.push('failed-close-and-changed-residual-volume-stop-instead-of-requesting-protection')
  const originalExpiry=plan.expiresAt
  const savePlan=async()=>{
    const hash=sha256Canonical(plan),registered={planHash:hash,parentIntentId:plan.parentIntentId,parentCommandId:plan.parentCommandId}
    await db.execute('UPDATE partial_close_workflows_v4 SET plan_json=?,plan_sha256=?,expires_at_utc=? WHERE id=?',[JSON.stringify(plan),hash,new Date(plan.expiresAt),scope.workflowId])
    await db.execute('UPDATE partial_close_workflow_events_v4 SET payload_json=?,payload_sha256=? WHERE workflow_id=? AND revision=1',[JSON.stringify(registered),sha256Canonical(registered),scope.workflowId])
  }
  await reset();const [[expiryClock]]=await db.query('SELECT UNIX_TIMESTAMP(UTC_TIMESTAMP(3))*1000 now_msc');plan.expiresAt=Number(expiryClock.now_msc)-1;await savePlan()
  assert.equal((await service.advance(scope)).status,'expired');assert.equal(historyCalls,0)
  await reset('uncertain')
  assert.equal((await service.advance(scope)).assessment.state,'reconcile_close');assert.equal(historyCalls,0)
  assert.deepEqual(await state(),pending)
  plan.expiresAt=originalExpiry;await savePlan()
  checks.push('expiry-does-not-depend-on-history-and-never-overrides-uncertain-reconciliation')
  for(const failAt of ['partial_close_workflow_events_v4','outbox_events']){
    await reset()
    await assert.rejects(make({failAt}).progress.advance(scope),/injected_progress_write_failure/)
    assert.deepEqual(await state(),pending)
  }
  checks.push('real-stage-audit-outbox-atomic-rollback-on-either-insert-failure')
  await reset()
  const uncertain=make({loseAck:true})
  await assert.rejects(uncertain.progress.advance(scope),{code:'bridge_command_commit_unknown'})
  assert.equal(uncertain.discarded(),1)
  assert.deepEqual(await state(),{status:'risk_review_required',revision:2,events:2,outbox:1})
  const reads=historyCalls
  const replay=await service.advance(scope)
  assert.equal(replay.replayed,true);assert.equal(replay.assessment.state,'risk_review_required');assert.equal(historyCalls,reads)
  checks.push('commit-ack-loss-replays-one-original-review-request-not-another-state-or-command')
  const [[audit]]=await db.execute('SELECT payload_json FROM partial_close_workflow_events_v4 WHERE workflow_id=? AND revision=2',[scope.workflowId])
  const saved=typeof audit.payload_json==='string'?JSON.parse(audit.payload_json):audit.payload_json
  assert.equal(saved.planHash,sha256Canonical(plan));assert.equal(saved.history.evidenceHash,sha256Canonical(saved.history.evidence))
  assert.match(saved.projectionHash,/^[0-9a-f]{64}$/);assert.equal(saved.assessment.remainingVolume,'0.02')
  const [[outbox]]=await db.execute('SELECT payload_json FROM outbox_events WHERE aggregate_id=?',[scope.workflowId])
  assert.deepEqual(typeof outbox.payload_json==='string'?JSON.parse(outbox.payload_json):outbox.payload_json,
    {workflow_id:scope.workflowId,user_id:7,trading_account_id:'5',revision:2})
  checks.push('review-request-retains-history-lineage-and-projection-digest-with-ID-only-outbox')
  await db.execute("UPDATE partial_close_workflow_events_v4 SET payload_json=JSON_SET(payload_json,'$.assessment.remainingVolume','0.03') WHERE workflow_id=? AND revision=2",[scope.workflowId])
  await assert.rejects(service.advance(scope),{code:'partial_close_progress_audit_corrupt'})
  checks.push('corrupt-saved-review-audit-cannot-replay-success')
  await reset()
  const results=await Promise.all([service.advance(scope),service.advance(scope)])
  assert.equal(results.filter(r=>r.replayed).length,1)
  assert.deepEqual(await state(),{status:'risk_review_required',revision:2,events:2,outbox:1})
  assert.equal(historyCalls,1)
  checks.push('two-real-connections-produce-one-stage-one-audit-and-one-outbox')
  return {passed:true,checks,schema:'candidate-056-with-existing-parent-query-scaffolds',factPorts:'injected-history-and-projection',riskReviewed:false,childCommandCreated:false,runtimeWired:false,existingDatabaseWrites:0}
}
