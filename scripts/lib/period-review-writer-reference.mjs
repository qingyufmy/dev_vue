import assert from 'node:assert/strict'
import { createMysqlPeriodReviewWriter } from '../../server/dist-v4/modules/reviews/composition.js'
import { MysqlOutboxRepository } from '../../server/dist-v4/outbox/infrastructure/mysql-outbox-repository.js'
import { verifyCollectedReviewResult } from './collected-review-result-reference.mjs'

/** Actual persisted system case and SQL/model pipeline; calendar proofs and full-period inventory are synthetic. */
export async function verifyPeriodReviewWriter(admin,pool,scope) {
  const [[db]]=await admin.query('SELECT DATABASE() db');assert.match(db.db,/^dev_vue_history_ref_[a-f0-9]{32}$/)
  const [[row]]=await admin.execute(`SELECT r.revision,r.evidence_sha256,CAST(TIMESTAMPDIFF(MICROSECOND,'1970-01-01',r.closed_at_utc) DIV 1000 AS CHAR) closed_msc
    FROM account_trade_records_v4 r WHERE r.id=?`,[scope.recordId])
  const closed=Number(row.closed_msc),local=new Date(closed+180*60000),results=[]
  for(const kind of ['daily','monthly']){
    const key=local.toISOString().slice(0,kind==='daily'?10:7)
    const start=new Date(`${key}${kind==='monthly'?'-01':''}T00:00:00Z`),end=new Date(start)
    if(kind==='daily')end.setUTCDate(end.getUTCDate()+1);else end.setUTCMonth(end.getUTCMonth()+1)
    const boundary=d=>({utcMsc:d.getTime()-180*60000,offsetMinutes:180,evidenceRef:'reference:synthetic-clock'})
    const selection={status:'selected',period:{kind,key,start:boundary(start),end:boundary(end)},accountId:scope.route.accountId,accountCurrency:'USD',
      asOfUtcMsc:boundary(end).utcMsc+1000,completionHash:'f'.repeat(64),exclusions:[],
      records:[{id:scope.recordId,revision:Number(row.revision),closedAtUtcMsc:closed,source:'system',attribution:'exact',evidenceHash:row.evidence_sha256,accountCurrency:'USD'}]}
    const c=await pool.getConnection()
    let collected
    try{
      await c.beginTransaction()
      const writer=createMysqlPeriodReviewWriter(c)
      const missing=structuredClone(selection);missing.records[0].id='missing'
      assert.equal((await writer.write(scope.userId,missing)).reason,'period_single_trade_evidence_missing')
      collected=await writer.write(scope.userId,selection)
      assert.equal(collected.status,'collected',JSON.stringify(collected));assert.equal(collected.results.length,1)
      assert.equal(collected.results[0].status,'queued')
      const replay=await writer.write(scope.userId,{...selection,completionHash:'e'.repeat(64)})
      assert.equal(replay.results[0].status,'unchanged')
      assert.equal(replay.results[0].caseId,collected.results[0].caseId)
      const changed=structuredClone(selection);changed.records[0].evidenceHash='a'.repeat(64)
      assert.equal((await writer.write(scope.userId,changed)).reason,'period_single_trade_source_changed')
      await c.commit()
    }catch(error){await c.rollback();throw error}finally{c.release()}
    const caseId=collected.results[0].caseId,outbox=new MysqlOutboxRepository(pool),deadline=Date.now()+15000
    let event
    while(!event&&Date.now()<deadline){event=(await outbox.claim(`period-${kind}-reference`,100,30,new Date())).find(e=>e.eventType==='review.job.requested'&&e.payload.review_case_id===caseId)
      if(!event)await new Promise(resolve=>setTimeout(resolve,250))}
    assert.ok(event)
    const model=await verifyCollectedReviewResult(admin,pool,scope,event,kind)
    results.push({kind,model})
  }
  return {passed:true,calendarAndInventory:'synthetic-full-period-authority',sourceCases:'actual-persisted-system-case',results,
    checks:['daily-and-monthly-case-job-outbox-committed','missing-or-changed-source-not-partially-written','new-inventory-task-replays-same-case','both-period-results-through-worker-and-http']}
}
