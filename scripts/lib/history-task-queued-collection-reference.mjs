import { verifyCollectedManualCase } from './history-manual-case-reference.mjs'
import { createTransactionManualCandidateSourceVerifier } from '../../server/dist-v4/bootstrap/manual-candidate-source-verifier.js'
import { splitSqlStatements } from './v4-migration-plan.mjs'
import { readFile } from 'node:fs/promises'
import { createTransactionManualCandidateCollector } from '../../server/dist-v4/bootstrap/manual-candidate-collection.js'
import { createMysqlManualCandidateWriter } from '../../server/dist-v4/modules/reviews/composition.js'
import { verifyClosedOrderHistoryReference } from './closed-order-history-reference.mjs'
import { ReadStrategyReferencePortfolio } from '../../server/dist-v4/modules/inference/index.js'
import { freezeStrategyReferencePortfolio } from '../../server/dist-v4/modules/inference/application/strategy-reference-portfolio.js'
import { createMysqlStrategyReferenceSourceReader } from '../../server/dist-v4/modules/inference/composition.js'
import { withReferenceEntrySqlFixture } from './reference-entry-sql-fixture.mjs'
import { withReferenceObserverSqlFixture } from './reference-observer-sql-fixture.mjs'
import { createStrategyReferencePortfolioReader } from '../../server/dist-v4/bootstrap/strategy-reference-evidence.js'
import { withReferenceGatewayLease } from './reference-gateway-lease-fixture.mjs'
import { createReferencePositionEvidenceReader } from '../../server/dist-v4/bootstrap/strategy-reference-position-evidence.js'
import { canonicalEvidence } from '../../server/dist-v4/modules/trade-history/index.js'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Worker } from 'bullmq'
import { createMysqlHistoryTaskWorker, createMysqlHistoryTaskCoverageReader, createMysqlHistoryTaskDealSourceReader, createMysqlHistoryWindowCoverageReader, createMysqlOpenPositionHistoryReader, createMysqlHistoryTaskDealInventoryReader, createTransactionReviewTradeReadinessReader } from '../../server/dist-v4/modules/trade-history/composition.js'
import { createAccountInventorySummaryReader } from '../../server/dist-v4/modules/trading/composition.js'
import { registerHistoryCollectionTask } from '../../server/dist-v4/modules/trade-history/infrastructure/mysql-history-task-registration.js'
import { historyTransaction } from '../../server/dist-v4/modules/trade-history/infrastructure/history-transaction.js'
import { createBridgeHistoryTaskProcessor } from '../../server/dist-v4/queue/bridge-history-task-processor.js'
import { BRIDGE_HISTORY_TASK_QUEUE } from '../../server/dist-v4/queue/task-queues.js'

export async function verifyQueuedCollection(admin,pool,route,queue,events,connection,prefix,outbox,publisher,snapshots) {
  const [[identity]] = await admin.query('SELECT DATABASE() db,UTC_TIMESTAMP(3) now')
  assert.match(identity.db,/^dev_vue_history_ref_[a-f0-9]{32}$/)
  await admin.query(snapshots.find(t=>t.name==='account_trade_record_deals_v4').ddl)
  const reviewDdl=await readFile(new URL('../../server/db/migrations/20260904_012_review_memory_core.sql',import.meta.url),'utf8')
  const candidateDdl=splitSqlStatements(reviewDdl).find(sql=>/^CREATE TABLE IF NOT EXISTS manual_review_candidates_v4 /m.test(sql))
  assert.ok(candidateDdl)
  await admin.query(candidateDdl)
  await admin.query(await readFile(new URL('../../server/db/migrations/inplace/073_manual_review_candidate_evidence.sql',import.meta.url),'utf8'))
  // Minimal parent scaffold; all ownership checks themselves use the real SQL adapter.
  await admin.query('ALTER TABLE trading_accounts ADD ownership_revision BIGINT NOT NULL DEFAULT 1, ADD platform VARCHAR(8)')
  await admin.execute('UPDATE trading_accounts SET ownership_revision=?,platform=? WHERE id=?',[route.ownershipRevision,route.platform,route.accountId])
  await admin.query('CREATE TABLE trading_account_ownerships (user_id INT,trading_account_id BIGINT UNSIGNED,role VARCHAR(16),revision BIGINT,interval_id CHAR(36),granted_at_utc DATETIME(3),revoked_at_utc DATETIME(3),PRIMARY KEY(user_id,trading_account_id,role)) ENGINE=InnoDB')
  await admin.execute(`INSERT INTO trading_account_ownerships (user_id,trading_account_id,role,revision,interval_id,granted_at_utc)
    SELECT user_id,trading_account_id,role,?,id,started_at_utc FROM trading_account_ownership_intervals WHERE user_id=? AND trading_account_id=? AND ended_at_utc IS NULL`,
    [route.ownershipRevision,route.userId,route.accountId])

  const now=new Date(), request={taskId:randomUUID(),accountId:route.accountId,rangeStartUtcMsc:now.getTime()-10000,rangeEndUtcMsc:now.getTime()}
  await historyTransaction(pool,c=>registerHistoryCollectionTask(c,createAccountInventorySummaryReader(c),request,now))
  const owner=randomUUID(), claimed=await outbox.claim(owner,500,30,now)
  const event=claimed.find(e=>e.eventType==='trade.history.task.requested'&&e.payload.task_id===request.taskId)
  assert.ok(event)
  const calls=[], failures=[]
  const query=async input=>{
    assert.deepEqual(input.route,route)
    assert.equal(input.rangeStartUtcMsc,request.rangeStartUtcMsc);assert.equal(input.rangeEndUtcMsc,request.rangeEndUtcMsc)
    calls.push({resource:input.resource,cursor:input.cursor})
    const first=input.resource==='history.deals'&&input.cursor===null
    if(input.resource==='history.orders') assert.equal(input.cursor,null)
    else assert.ok(first||input.cursor==='deals-page-2')
    const raw={ticket:first?'60001':'60002',order:first?'61001':'61002',position_id:'60000',symbol:'XAUUSD',type:first?'buy':'sell',entry:first?'in':'out',
      time_msc:request.rangeStartUtcMsc+(first?100:200),volume:'1',price:first?'2500':'2512',profit:first?'0':'12',commission:'-1',swap:'0',fee:'0',account_currency:'USD',currency_evidence:'explicit_record',reason:first?0:1}
    return {v:4,type:'query.response',message_id:randomUUID(),correlation_id:randomUUID(),sent_at_utc_msc:now.getTime(),
      route:{terminal_instance_id:route.terminalInstanceId,account_ref:{broker_server:route.brokerServer,login:route.login},connection_epoch:route.connectionEpoch},
      payload:{request_id:randomUUID(),resource:input.resource,source:'terminal',source_revision:'queued-collection-v1',observed_at_utc_msc:now.getTime(),
        history_coverage:{version:1,status:'complete',range_start_utc_msc:request.rangeStartUtcMsc,range_end_utc_msc:request.rangeEndUtcMsc,source_revision:'queued-collection-v1',collected_at_utc_msc:now.getTime()},
        items:input.resource==='history.orders'?[]:[raw],has_more:first,next_cursor:first?'deals-page-2':null}}
  }
  const guard=()=>({async assert(candidate){assert.deepEqual(candidate,route)}})
  const processor=createBridgeHistoryTaskProcessor(createMysqlHistoryTaskWorker(pool,{query},{async current(accountId){assert.equal(accountId,route.accountId);return route}},guard))
  const worker=new Worker(BRIDGE_HISTORY_TASK_QUEUE,processor,{connection,prefix,autorun:false,concurrency:1})
  worker.on('error',()=>failures.push('worker_error'));worker.on('failed',(_job,error)=>failures.push(/^[a-z0-9_]+$/.test(error.message)?error.message:(/^ER_[A-Z0-9_]+$/.test(error.code??'')?error.code:'job_failed')))
  let run
  try {
    await worker.waitUntilReady()
    const [[before]]=await admin.query('SELECT history_revision FROM trade_history_sync_states_v4 WHERE trading_account_id=5')
    await publisher.publish(event)
    const job=await queue.getJob(event.eventId);assert.ok(job)
    assert.equal(await outbox.markDispatched(event.id,owner,now),true)
    run=worker.run().catch(()=>failures.push('worker_run_failed'))
    const outcome = await job.waitUntilFinished(events,20000)
    if(failures.length) throw Error(failures[0].toLowerCase())
    assert.deepEqual(outcome,{state:'succeeded',freshThroughUtcMsc:request.rangeEndUtcMsc})
    assert.deepEqual(calls,[{resource:'history.orders',cursor:null},{resource:'history.deals',cursor:null},{resource:'history.deals',cursor:'deals-page-2'}])
    assert.deepEqual(failures,[])
    const capture=async()=>{
      const [[task]]=await admin.execute('SELECT * FROM history_collection_tasks_v4 WHERE id=?',[request.taskId])
      const [[sync]]=await admin.query('SELECT * FROM trade_history_sync_states_v4 WHERE trading_account_id=5')
      const [facts]=await admin.query("SELECT * FROM terminal_history_deals_v4 WHERE deal_ticket IN ('60001','60002') ORDER BY deal_ticket")
      const [sources]=await admin.query("SELECT p.* FROM terminal_history_deal_provenance_v4 p JOIN terminal_history_deals_v4 d ON d.id=p.terminal_history_deal_id WHERE d.deal_ticket IN ('60001','60002') ORDER BY d.deal_ticket")
      const [records]=await admin.query("SELECT * FROM account_trade_records_v4 WHERE stable_trade_key='mt5:position:60000'")
      const [links]=await admin.query("SELECT l.* FROM account_trade_record_deals_v4 l JOIN account_trade_records_v4 r ON r.id=l.trade_record_id WHERE r.stable_trade_key='mt5:position:60000' ORDER BY sequence_number")
      const [[receipt]]=await admin.execute('SELECT * FROM terminal_history_collection_receipts_v4 WHERE id=?',[task.result_receipt_id])
      return {task,sync,facts,sources,records,links,receipt}
    }
    const completed=await capture()
    assert.equal(completed.task.status,'succeeded');assert.equal(completed.sync.status,'ready')
    assert.equal(BigInt(completed.sync.history_revision),BigInt(before.history_revision)+1n)
    assert.equal(completed.facts.length,2);assert.equal(completed.sources.length,2);assert.equal(completed.links.length,2)
    assert.equal(completed.records.length,1);assert.equal(completed.records[0].status,'closed');assert.equal(completed.records[0].net_profit,'10.00000000')
    assert.equal(Number(completed.records[0].user_id),route.userId)
    const prepared=typeof completed.task.completion_json==='string'?JSON.parse(completed.task.completion_json):completed.task.completion_json
    assert.equal(canonicalEvidence(prepared).hash,completed.task.completion_sha256)
    assert.equal(prepared.taskId,request.taskId)
    assert.equal(prepared.pageChains.length,2)
    for(const chain of prepared.pageChains) assert.deepEqual(chain.historyCoverage,{version:1,status:'complete',range_start_utc_msc:request.rangeStartUtcMsc,range_end_utc_msc:request.rangeEndUtcMsc,source_revision:'queued-collection-v1',collected_at_utc_msc:now.getTime()})
    const evidence=typeof completed.receipt.evidence_json==='string'?JSON.parse(completed.receipt.evidence_json):completed.receipt.evidence_json
    assert.equal(evidence.resources.find(r=>r.resource==='history.deals').pageCount,2)
    assert.equal(evidence.resources.find(r=>r.resource==='history.deals').itemCount,2)
    await job.remove()
    await publisher.publish(event)
    const replay=await queue.getJob(event.eventId);assert.ok(replay)
    assert.deepEqual(await replay.waitUntilFinished(events,20000),{state:'terminal',status:'succeeded'})
    assert.equal(calls.length,3);assert.deepEqual(await capture(),completed)
    let closedOrderHistory
    const evidenceConnection=await pool.getConnection()
    try {
      await evidenceConnection.query("SET SESSION time_zone='+08:00'")
      const windowReader=createMysqlHistoryWindowCoverageReader(evidenceConnection)
      const windowScope={route,rangeStartUtcMsc:request.rangeStartUtcMsc,rangeEndUtcMsc:request.rangeEndUtcMsc}
      const windowCoverage=await windowReader.read(windowScope)
      assert.equal(windowCoverage.status,'provider_asserted');assert.equal(windowCoverage.taskId,request.taskId)
      assert.deepEqual(await windowReader.read({...windowScope,rangeEndUtcMsc:request.rangeEndUtcMsc+1}),{status:'unresolved',reason:'task_unavailable'})
      assert.deepEqual(await windowReader.read({...windowScope,route:{...route,login:'another'}}),{status:'unresolved',reason:'task_unavailable'})
      closedOrderHistory=await verifyClosedOrderHistoryReference(evidenceConnection,route,request)
      const coverageReader=createMysqlHistoryTaskCoverageReader(evidenceConnection)
      const coverage=await coverageReader.read({taskId:request.taskId,route})
      assert.equal(coverage.status,'provider_asserted');assert.equal(coverage.receiptId,completed.receipt.id)
      assert.deepEqual(coverage.resources,prepared.pageChains)
      const positionReader=createMysqlOpenPositionHistoryReader(evidenceConnection)
      const positionProof=await positionReader.read({route,positionIdentifier:'60000',symbol:'XAUUSD',side:'buy',volume:'1',observedAtUtcMsc:request.rangeStartUtcMsc+150})
      assert.equal(positionProof.status,'source_matched');assert.equal(positionProof.taskId,request.taskId)
      assert.deepEqual(positionProof.lifecycle.contributingOrderTickets,['61001']);assert.deepEqual(positionProof.deals.map(d=>d.ticket),['60001'])
      const inventory={route,authorization:{operatorUserId:route.userId,ownershipRevision:route.ownershipRevision},
        positions:{revision:1,observedAt:new Date(request.rangeStartUtcMsc+150).toISOString(),items:[{
          accountId:route.accountId,ticket:'60010',positionIdentifier:'60000',revision:1,symbol:'XAUUSD',side:'buy',volume:'1',openPrice:'2500',stopLoss:null,takeProfit:null}]}}
      let currentRoute=route
      const referenceReader=createReferencePositionEvidenceReader({async current(){return currentRoute}},positionReader)
      await evidenceConnection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
      await evidenceConnection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
      const snapshotSource=completed.sources[0]
      try {
        const referenceProof=await referenceReader.read(inventory)
        assert.deepEqual(referenceProof,{status:'read',items:[{ticket:'60010',history:positionProof}]})
        await admin.execute("UPDATE terminal_history_deal_provenance_v4 SET provenance_sha256=REPEAT('e',64) WHERE id=?",[snapshotSource.id])
        // Concurrent changes must not mix the lifecycle and source evidence across snapshots.
        assert.deepEqual(await referenceReader.read(inventory),referenceProof)
        currentRoute={...route,ownershipRevision:String(BigInt(route.ownershipRevision)+1n)}
        assert.deepEqual(await referenceReader.read(inventory),{status:'unresolved',reason:'route_unavailable'})
        currentRoute=route
      } finally {await evidenceConnection.rollback()}
      try { await assert.rejects(referenceReader.read(inventory),/history_deal_source_corrupt/) }
      finally { await admin.execute('UPDATE terminal_history_deal_provenance_v4 SET provenance_sha256=? WHERE id=?',[snapshotSource.provenance_sha256,snapshotSource.id]) }
      assert.deepEqual(await referenceReader.read(inventory),{status:'read',items:[{ticket:'60010',history:positionProof}]})
      const referenceAnalysisId=randomUUID()
      const referenceInventory={...inventory,analysisStrategyId:'20',observedAt:inventory.positions.observedAt,pendingOrders:{revision:1,items:[]},
        authorization:{...inventory.authorization,userId:route.userId,accountId:route.accountId,expiresAtUtc:new Date(Date.now()+60000).toISOString()}}
      const referenceSource=createMysqlStrategyReferenceSourceReader(pool,
        ()=>({async read(){return referenceInventory}}),
        ()=>({async read(){return {analysisId:referenceAnalysisId,sourceAccountId:route.accountId}}}),
        ()=>({async read(){return []}}),undefined,
        ()=>({async read(scope){assert.deepEqual(scope.tickets,['61001']);return [{ticket:'61001',status:'strategy',userId:route.userId,accountId:route.accountId,strategyId:'21'}]}}),
        c=>createReferencePositionEvidenceReader({async current(){return route}},createMysqlOpenPositionHistoryReader(c)))
      const referenceResult=await referenceSource.read({userId:route.userId,analysisId:referenceAnalysisId,analysisStrategyId:'20',symbol:'XAUUSD',asOf:inventory.positions.observedAt})
      assert.deepEqual(referenceResult.positionEvidence,{status:'read',items:[{ticket:'60010',history:positionProof}]})
      assert.deepEqual(referenceResult.positionOrigins,{status:'read',items:[{ticket:'60010',status:'creation_strategy_matched',strategyId:'21',orderTickets:['61001'],creationDecisions:null}]})
      const portfolioScope={userId:route.userId,analysisId:referenceAnalysisId,analysisStrategyId:'20',traderStrategyId:'21',targetAccountId:'999',symbol:'XAUUSD',asOf:inventory.positions.observedAt}
      const portfolio=await freezeStrategyReferencePortfolio(portfolioScope,new ReadStrategyReferencePortfolio(referenceSource))
      assert.equal(portfolio.state,'ready');assert.equal(portfolio.purpose,'strategy_reference_only')
      assert.equal(portfolio.positions.length,1);assert.equal(portfolio.positions[0].entryPrice,'2500')
      assert.match(portfolio.positions[0].referenceId,/^position:[0-9a-f]{64}$/)
      assert.equal(portfolio.pendingOrders.length,0);assert.ok(!JSON.stringify(portfolio).includes('60010'))
      await withReferenceGatewayLease(route,leases=>withReferenceObserverSqlFixture(evidenceConnection,referenceInventory,()=>withReferenceEntrySqlFixture(evidenceConnection,{userId:route.userId,accountId:route.accountId,route},async fixture=>{
        const lease=new Proxy(evidenceConnection,{get(target,key){
          if(key==='release')return ()=>{}
          const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
        }})
        const modelReference=createStrategyReferencePortfolioReader({async getConnection(){return lease}},leases)
        const read=()=>freezeStrategyReferencePortfolio({...portfolioScope,analysisId:fixture.ids.analysis},modelReference)
        const ready=await read(),entry=ready.positions[0].entryEvidence
        assert.equal(entry.state,'ready');assert.equal(entry.purpose,'creation_analysis_only')
        assert.equal(entry.entries[0].analyzedAt,fixture.result.analyzedAt)
        assert.deepEqual(entry.entries[0].keyLevels,fixture.result.keyLevels)
        assert.equal(entry.entries[0].traderStrategyVersionId,'211')
        // The scope legitimately carries the requested analysis ID; model positions carry no internal lineage IDs.
        for(const id of Object.values(fixture.ids))assert.equal(JSON.stringify(ready.positions).includes(id),false)
        await evidenceConnection.execute('UPDATE bridge_commands_v4 SET account_login=?',['different-account'])
        try{await assert.rejects(read(),{code:'strategy_reference_portfolio_unavailable'})}
        finally{await evidenceConnection.execute('UPDATE bridge_commands_v4 SET account_login=?',[route.login])}
        await evidenceConnection.query("UPDATE trade_decisions SET risk_decision_id='different-risk'")
        try{await assert.rejects(read(),{code:'execution_dedup_origin_invalid'})}
        finally{await evidenceConnection.execute('UPDATE trade_decisions SET risk_decision_id=?',[fixture.ids.risk])}
        await evidenceConnection.execute("UPDATE market_analysis_payloads SET payload_sha256=REPEAT('f',64) WHERE market_analysis_id=?",[fixture.ids.analysis])
        const missing=await read()
        assert.equal(missing.state,'ready')
        assert.deepEqual(missing.positions[0].entryEvidence,{schemaVersion:1,state:'unavailable',reason:'entry_analysis_unavailable'})
        await evidenceConnection.execute('UPDATE history_collection_tasks_v4 SET range_end_utc=? WHERE id=?',[new Date(request.rangeStartUtcMsc+149),request.taskId])
        // Restore the isolated task even if the expected denial fails.
        try{await assert.rejects(read(),{code:'strategy_reference_portfolio_unavailable'})}
        finally{
          await evidenceConnection.execute('UPDATE history_collection_tasks_v4 SET range_end_utc=? WHERE id=?',[new Date(request.rangeEndUtcMsc),request.taskId])
        }
        await evidenceConnection.query('UPDATE observer_channels SET active=0')
        try{await assert.rejects(read(),{code:'strategy_reference_inventory_unavailable'})}
        finally{await evidenceConnection.query('UPDATE observer_channels SET active=1')}
        await leases.release(route)
        await assert.rejects(read(),{code:'strategy_reference_inventory_unavailable'})
        await leases.claim({route,capacity:1,ttlSeconds:30})
        assert.equal((await read()).state,'ready')
      })))
      const sourceReader=createMysqlHistoryTaskDealSourceReader(evidenceConnection)
      const sourceScope={taskId:request.taskId,route,dealTickets:['60001','60002']}
      const matched=await sourceReader.read(sourceScope)
      assert.equal(matched.status,'source_matched');assert.equal(matched.deals.length,2)
      assert.deepEqual(matched.deals.map(d=>d.ticket),sourceScope.dealTickets)
      assert.ok(matched.deals.every(d=>d.provenanceHashes.length===1))
      const inventoryReader=createMysqlHistoryTaskDealInventoryReader(evidenceConnection)
      const inventoryScope={taskId:request.taskId,route}
      const taskInventory=await inventoryReader.read(inventoryScope)
      assert.equal(taskInventory.status,'inventory_matched')
      assert.deepEqual(taskInventory.facts.map(f=>f.ticket).sort(),['60001','60002'])
      assert.equal(taskInventory.receiptId,matched.receiptId)
      assert.equal(taskInventory.completionHash,matched.completionHash)
      // Terminal facts are synthetic; the production collector derives attribution from their explicit reasons.
      const reviewRecord=completed.records[0]
      await evidenceConnection.beginTransaction()
      try {
        const readinessReader=createTransactionReviewTradeReadinessReader(evidenceConnection)
        const reviewScope={userId:route.userId,recordId:reviewRecord.id,expectedRevision:Number(reviewRecord.revision),
          taskId:request.taskId,route,connection,prefix,asOfUtcMsc:request.rangeEndUtcMsc}
        assert.equal(reviewRecord.source_classification,'manual')
        assert.equal(reviewRecord.attribution_status,'exact')
        const reviewReady=await readinessReader.read(reviewScope)
        assert.equal(reviewReady.status,'ready_as_of')
        assert.equal(reviewReady.evidence.projection.netProfit,'10')
        assert.deepEqual(reviewReady.evidence.facts.map(f=>f.ticket).sort(),['60001','60002'])
        assert.equal(reviewReady.receiptId,taskInventory.receiptId)
        assert.equal(reviewReady.completionHash,taskInventory.completionHash)
        const candidateWriter=createMysqlManualCandidateWriter(evidenceConnection)
        const candidateCollector=createTransactionManualCandidateCollector(evidenceConnection)
        const candidate=await candidateCollector.collect(reviewScope)
        assert.equal(candidate.status,'created');assert.equal(candidate.revision,1)
        assert.deepEqual(await candidateCollector.collect(reviewScope),{...candidate,status:'unchanged'})
        await evidenceConnection.execute('UPDATE trading_account_ownerships SET revoked_at_utc=UTC_TIMESTAMP(3) WHERE user_id=? AND trading_account_id=?',[route.userId,route.accountId])
        assert.deepEqual(await candidateCollector.collect(reviewScope),{status:'unresolved',reason:'review_ownership_unavailable'})
        await evidenceConnection.execute('UPDATE trading_account_ownerships SET revoked_at_utc=NULL WHERE user_id=? AND trading_account_id=?',[route.userId,route.accountId])

        const [[frozenCandidate]]=await evidenceConnection.execute('SELECT evidence_sha256,selection_token_sha256 FROM manual_review_candidates_v4 WHERE id=?',[candidate.candidateId])
        const [[frozenPayload]]=await evidenceConnection.execute('SELECT evidence_json,evidence_sha256 FROM manual_review_candidate_evidence_v4 WHERE candidate_id=? AND candidate_revision=1',[candidate.candidateId])
        assert.equal(frozenPayload.evidence_sha256,frozenCandidate.evidence_sha256)
        const payloadValue=typeof frozenPayload.evidence_json==='string'?JSON.parse(frozenPayload.evidence_json):frozenPayload.evidence_json
        assert.equal(payloadValue.trade.receiptId,reviewReady.receiptId)
        assert.equal(payloadValue.trade.evidence.facts.length,2)
        assert.equal(payloadValue.authority.timeSemantics,'utc_trade_lifecycle')
        assert.equal(payloadValue.authority.terminalDisplay.historicalIntervalVerified,false)
        assert.equal(payloadValue.authority.ownership.historicalOwnershipIntervalId,reviewReady.evidence.ownershipIntervalId)
        const verifyCandidateSource=createTransactionManualCandidateSourceVerifier(evidenceConnection)
        await verifyCandidateSource.verify(payloadValue,route.userId)
        await evidenceConnection.execute('UPDATE account_trade_records_v4 SET revision=revision+1 WHERE id=?',[reviewRecord.id])
        await assert.rejects(verifyCandidateSource.verify(payloadValue,route.userId),{code:'manual_review_source_changed'})
        await evidenceConnection.execute('UPDATE account_trade_records_v4 SET revision=revision-1 WHERE id=?',[reviewRecord.id])
        await evidenceConnection.execute('UPDATE trading_account_ownerships SET revoked_at_utc=UTC_TIMESTAMP(3) WHERE user_id=? AND trading_account_id=?',[route.userId,route.accountId])
        await assert.rejects(verifyCandidateSource.verify(payloadValue,route.userId),{code:'manual_review_source_changed'})
        await evidenceConnection.execute('UPDATE trading_account_ownerships SET revoked_at_utc=NULL WHERE user_id=? AND trading_account_id=?',[route.userId,route.accountId])

        await evidenceConnection.execute("UPDATE manual_review_candidates_v4 SET selection_expires_at_utc='2000-01-01 00:00:00' WHERE id=?",[candidate.candidateId])
        const renewed=await candidateCollector.collect(reviewScope)
        assert.deepEqual(renewed,{status:'updated',candidateId:candidate.candidateId,revision:2})
        const [[renewedCandidate]]=await evidenceConnection.execute('SELECT selection_token_sha256 FROM manual_review_candidates_v4 WHERE id=?',[candidate.candidateId])
        assert.notEqual(renewedCandidate.selection_token_sha256,frozenCandidate.selection_token_sha256)
        const [[versions]]=await evidenceConnection.execute('SELECT COUNT(*) n FROM manual_review_candidate_evidence_v4 WHERE candidate_id=?',[candidate.candidateId])
        assert.equal(Number(versions.n),2)
        const oldCutoff={...reviewReady,asOfUtcMsc:reviewReady.asOfUtcMsc-1}
        await assert.rejects(candidateWriter.write({trade:oldCutoff,authority:payloadValue.authority}),{code:'manual_review_evidence_stale'})
        await evidenceConnection.execute("UPDATE manual_review_candidates_v4 SET eligibility_status='already_reviewed',revision=revision+1 WHERE id=?",[candidate.candidateId])
        assert.deepEqual(await candidateCollector.collect(reviewScope),{status:'already_reviewed',candidateId:candidate.candidateId,revision:3})

        assert.deepEqual(await readinessReader.read({...reviewScope,expectedRevision:reviewScope.expectedRevision+1}),
          {status:'unresolved',reason:'revision_changed'})
        await evidenceConnection.execute('DELETE FROM account_trade_record_deals_v4 WHERE trade_record_id=? AND terminal_deal_id=?',
          [reviewRecord.id,taskInventory.facts[0].id])
        assert.deepEqual(await readinessReader.read(reviewScope),{status:'unresolved',reason:'facts_incomplete'})
      } finally {await evidenceConnection.rollback()}

      const absent=taskInventory.facts.find(f=>f.ticket==='60002')
      await admin.execute("UPDATE terminal_history_deals_v4 SET evidence_sha256=REPEAT('e',64) WHERE id=?",[absent.id])
      try {
        assert.deepEqual(await inventoryReader.read(inventoryScope),{status:'unresolved',reason:'inventory_missing'})
      } finally {await admin.execute('UPDATE terminal_history_deals_v4 SET evidence_sha256=? WHERE id=?',[absent.hash,absent.id])}
      assert.equal((await inventoryReader.read(inventoryScope)).status,'inventory_matched')
      assert.deepEqual(await sourceReader.read({...sourceScope,dealTickets:['60001','999999']}),{status:'unresolved',reason:'source_missing'})
      const member=prepared.pageChains.find(c=>c.resource==='history.deals').pageMembership
      assert.equal(member.version,1);assert.equal(member.pages.length,2)
      assert.ok(completed.sources.every(p=>member.pages.some(page=>page.requestId===p.request_id
        && page.queryMessageId===p.query_message_id && page.responseMessageId===p.response_message_id
        && page.factHashes.includes(p.fact_sha256))))
      const p=completed.sources[0]
      const originalProof={version:1,dealId:p.terminal_history_deal_id,accountId:String(p.trading_account_id),userId:Number(p.user_id),
        platform:p.platform,terminalInstanceId:p.terminal_instance_id,terminalProfileId:p.terminal_profile_id,brokerServer:p.broker_server,
        login:p.account_login,connectionId:p.connection_id,connectionEpoch:String(p.connection_epoch),ownershipRevision:String(p.ownership_revision),
        requestId:p.request_id,queryMessageId:p.query_message_id,responseMessageId:p.response_message_id,sourceRevision:p.source_revision,
        sourceKind:p.source_kind,factHash:p.fact_sha256,observedAt:new Date(p.observed_at_utc).toISOString()}
      assert.equal(canonicalEvidence(originalProof).hash,p.provenance_sha256)
      const foreignProof={...originalProof,requestId:randomUUID(),queryMessageId:randomUUID(),responseMessageId:randomUUID()}
      try {
        await admin.execute('UPDATE terminal_history_deal_provenance_v4 SET request_id=?,query_message_id=?,response_message_id=?,provenance_sha256=? WHERE id=?',
          [foreignProof.requestId,foreignProof.queryMessageId,foreignProof.responseMessageId,canonicalEvidence(foreignProof).hash,p.id])
        // Valid provenance and identical source revision are insufficient when the response is outside this task.
        assert.deepEqual(await sourceReader.read(sourceScope),{status:'unresolved',reason:'source_missing'})
      } finally {
        await admin.execute('UPDATE terminal_history_deal_provenance_v4 SET request_id=?,query_message_id=?,response_message_id=?,provenance_sha256=? WHERE id=?',
          [p.request_id,p.query_message_id,p.response_message_id,p.provenance_sha256,p.id])
      }
      const sourceRow=completed.sources[0]
      await admin.execute("UPDATE terminal_history_deal_provenance_v4 SET provenance_sha256=REPEAT('c',64) WHERE id=?",[sourceRow.id])
      await assert.rejects(sourceReader.read(sourceScope),/history_deal_source_corrupt/)
      await admin.execute('UPDATE terminal_history_deal_provenance_v4 SET provenance_sha256=? WHERE id=?',[sourceRow.provenance_sha256,sourceRow.id])
      await admin.execute("UPDATE terminal_history_deal_provenance_v4 SET source_revision='other-snapshot' WHERE id=?",[sourceRow.id])
      assert.deepEqual(await sourceReader.read(sourceScope),{status:'unresolved',reason:'source_missing'})
      await admin.execute('UPDATE terminal_history_deal_provenance_v4 SET source_revision=? WHERE id=?',[sourceRow.source_revision,sourceRow.id])
      assert.deepEqual(await coverageReader.read({taskId:request.taskId,route:{...route,login:'another'}}),{status:'unresolved',reason:'route_mismatch'})
      await admin.execute("UPDATE terminal_history_collection_receipts_v4 SET evidence_sha256=REPEAT('d',64) WHERE id=?",[completed.receipt.id])
      await assert.rejects(coverageReader.read({taskId:request.taskId,route}),/history_task_coverage_corrupt/)
      await admin.execute('UPDATE terminal_history_collection_receipts_v4 SET evidence_sha256=? WHERE id=?',[completed.receipt.evidence_sha256,completed.receipt.id])
      assert.deepEqual(await capture(),completed)
    } finally {evidenceConnection.release()}
    const manualCase=await verifyCollectedManualCase(admin,pool,{userId:route.userId,recordId:completed.records[0].id,
      expectedRevision:Number(completed.records[0].revision),taskId:request.taskId,route,connection,prefix,asOfUtcMsc:request.rangeEndUtcMsc})
    return {passed:true,manualCase,closedOrderHistory,modelReferencePortfolioVerified:true,exactPageMembershipVerified:true,referencePositionSnapshotVerified:true,referencePositionCreationCompositionVerified:true,referenceInventoryAndOrigin:"injected-ports-not-authorization-proof",positionHistoryVerified:true,windowCoverageVerified:true,dealSourceVerified:true,coverageReaderVerified:true,coveragePersisted:true,queryCount:calls.length,checks:['queued-pending-task-collects-fixed-window-through-two-deal-pages',
      'actual-history-and-entry-analysis-sql-produce-frozen-model-reference',
      'full-task-deal-inventory-requires-every-collected-page-fact',
      'review-readiness-uses-collector-derived-terminal-manual-attribution',
      'manual-candidate-freezes-replays-renews-and-never-reopens-consumed-record',
      'actual-ownership-authority-denies-revocation-in-collected-candidate-chain',
      'candidate-source-revalidation-rejects-revision-change-and-revoked-owner',
      'actual-analysis-source-authorization-and-inventory-sql-join-history-and-entry-analysis',
      'actual-runtime-bootstrap-with-sql-opening-order-decision-origin',
      'mismatched-terminal-login-and-risk-decision-reject-reference',
      'real-isolated-redis-route-lease-read-release-denial-and-reclaim',
      'revoked-observation-channel-denies-the-combined-sql-chain',
      'corrupt-entry-payload-is-explicitly-unavailable-without-current-analysis-fallback',
      'missing-completed-history-coverage-rejects-model-reference',
      'two-facts-and-provenance-produce-one-owned-closed-position', 'completion-receipt-captures-page-count-and-one-revision',
      'recreated-queue-job-confirms-durable-terminal-state-without-requery','explicit-coverage-survives-task-completion-ack-loss-and-job-recreation'],terminalTransport:'synthetic-query-port',platform:'mt5'}
  } finally {await worker.close(true);if(run) await run}
}
