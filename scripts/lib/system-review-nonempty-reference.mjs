import assert from 'node:assert/strict'
import { executedDealReferenceTables } from './executed-deal-origin-reference.mjs'
import { canonicalHash } from '../../server/dist-v4/modules/execution/domain/bridge-command.js'
import { contentHash } from '../../server/dist-v4/modules/inference/domain/inference.js'
import { decodeTerminalHistoryPage } from '../../server/dist-v4/modules/trade-history/index.js'
import { createTransactionSystemTradeReviewCollector } from '../../server/dist-v4/bootstrap/system-trade-review.js'
import { MysqlOutboxRepository } from '../../server/dist-v4/outbox/infrastructure/mysql-outbox-repository.js'
import { verifyCollectedReviewResult } from './collected-review-result-reference.mjs'
import { createMysqlPeriodTradeInventory } from '../../server/dist-v4/modules/trade-history/composition.js'

/** Actual collector adapters and persisted case/model result. Historical execution rows are synthetic fixtures. */
export async function verifyNonemptySystemReview(admin,pool,scope,asOfUtcMsc) {
  const c=await pool.getConnection(), created=[]
  let queued, destroyed=false
  try {
    const [[db]]=await c.query('SELECT DATABASE() db')
    assert.match(db.db,/^dev_vue_history_ref_[a-f0-9]{32}$/)
    const tables={...executedDealReferenceTables,
      trade_decisions:'id VARCHAR(64),trader_run_id VARCHAR(64),user_id INT,trading_account_id BIGINT,market_analysis_id VARCHAR(64),strategy_id BIGINT,strategy_version_id BIGINT,input_snapshot_id VARCHAR(64),risk_decision_id VARCHAR(64),status VARCHAR(32),content_sha256 CHAR(64)',
      ai_trader_runs:'id VARCHAR(64),user_id INT,trading_account_id BIGINT,strategy_id BIGINT,strategy_version_id BIGINT,market_analysis_id VARCHAR(64),input_snapshot_id VARCHAR(64),status VARCHAR(32),subscription_id BIGINT,subscription_revision BIGINT',
      trade_decision_payloads:'trade_decision_id VARCHAR(64),payload_json JSON,payload_sha256 CHAR(64)',
      inference_snapshots:'id VARCHAR(64),user_id INT,trading_account_id BIGINT,strategy_id BIGINT,strategy_version_id BIGINT,purpose VARCHAR(32),payload_sha256 CHAR(64)',
      inference_snapshot_payloads:'snapshot_id VARCHAR(64),encoding VARCHAR(32),payload_json JSON',
      market_analyses:'id VARCHAR(64),content_sha256 CHAR(64)',
      risk_decisions_v4:'id VARCHAR(64),trade_decision_id VARCHAR(64),user_id INT,trading_account_id BIGINT,decision_status VARCHAR(32),reject_code VARCHAR(64),policy_sha256 CHAR(64),platform_policy_version_id BIGINT,account_policy_version_id BIGINT,policy_set_revision BIGINT,account_risk_revision BIGINT',
      risk_decision_payloads_v4:'risk_decision_id VARCHAR(64),evaluation_json JSON,payload_sha256 CHAR(64)',
    }
    for(const [name,fields] of Object.entries(tables)){await c.query(`CREATE TEMPORARY TABLE ${name} (${fields})`);created.push(name)}
    const [rows]=await c.execute(`SELECT d.evidence_json FROM account_trade_record_deals_v4 x JOIN terminal_history_deals_v4 d ON d.id=x.terminal_deal_id
      WHERE x.trade_record_id=? ORDER BY x.sequence_number`,[scope.recordId])
    const facts=rows.map(row=>decodeTerminalHistoryPage('deals',[typeof row.evidence_json==='string'?JSON.parse(row.evidence_json):row.evidence_json])[0])
    assert.equal(facts.length,2)
    const sqlTime=msc=>new Date(msc).toISOString().slice(0,23).replace('T',' ')
    for(const f of facts){
      const suffix=f.ticket,command=`cmd-${suffix}`,intent=`intent-${suffix}`,decision=`decision-${suffix}`,risk=`risk-${suffix}`
      const run=`run-${suffix}`,snapshotId=`snapshot-${suffix}`,analysisId=`analysis-${suffix}`,message=`message-${suffix}`
      const action=f.entryKind==='in'?'order.place':'position.close',actionKind=f.entryKind==='in'?'market_order':'close_position'
      const issued=f.occurredAtUtcMsc-500,completed=f.occurredAtUtcMsc+500
      const request={v:4,type:'command.request',correlation_id:intent,route:{terminal_instance_id:scope.route.terminalInstanceId,
        account_ref:{broker_server:scope.route.brokerServer,login:scope.route.login},connection_epoch:scope.route.connectionEpoch},
        payload:{command_id:command,action,issued_at_utc_msc:issued,params:{ticket:f.positionId}}}
      const result={order:f.orderTicket,deal:f.ticket,position:f.positionId}
      const resultHash=canonicalHash({command_id:command,action,status:'succeeded',completed_at_utc_msc:completed,result,error_code:null,terminal_code:10009})
      await c.execute('INSERT INTO execution_intents VALUES (?,?,?,\'risk_decision\',?,?,?,\'succeeded\',?)',[intent,scope.userId,scope.route.accountId,risk,decision,risk,actionKind])
      await c.execute('INSERT INTO bridge_commands_v4 VALUES (?,?,?,?,?,\'succeeded\',?,?,?,?,?,?,?, ?,?)',
        [command,intent,scope.userId,scope.route.accountId,action,message,resultHash,canonicalHash(request.payload),scope.route.terminalInstanceId,scope.route.brokerServer,scope.route.login,scope.route.connectionEpoch,sqlTime(issued),sqlTime(completed)])
      await c.execute('INSERT INTO bridge_command_payloads_v4 VALUES (?,?)',[command,JSON.stringify(request)])
      await c.execute('INSERT INTO bridge_command_results_v4 VALUES (?,?,?,?,?,?,\'10009\',\'succeeded\',0,NULL)',[command,message,resultHash,action,sqlTime(completed),JSON.stringify(result)])
      const analysis={summary:'Reference historical analysis'},output={action:actionKind,summary:'Reference decision'}
      const snapshot={kind:'trader',strategy:{id:'1',versionId:'1'},account:{id:scope.route.accountId},analysis:{id:analysisId,contentHash:contentHash(analysis),result:analysis},subscriptionRevision:1}
      await c.execute('INSERT INTO trade_decisions VALUES (?,?,?,?,?,1,1,?,?,\'accepted\',?)',[decision,run,scope.userId,scope.route.accountId,analysisId,snapshotId,risk,contentHash(output)])
      await c.execute('INSERT INTO ai_trader_runs VALUES (?,?,?,1,1,?,?,\'succeeded\',1,1)',[run,scope.userId,scope.route.accountId,analysisId,snapshotId])
      await c.execute('INSERT INTO trade_decision_payloads VALUES (?,?,?)',[decision,JSON.stringify(output),contentHash(output)])
      await c.execute('INSERT INTO inference_snapshots VALUES (?,?,?,1,1,\'trader\',?)',[snapshotId,scope.userId,scope.route.accountId,contentHash(snapshot)])
      await c.execute('INSERT INTO inference_snapshot_payloads VALUES (?,\'json\',?)',[snapshotId,JSON.stringify(snapshot)])
      await c.execute('INSERT INTO market_analyses VALUES (?,?)',[analysisId,contentHash(analysis)])
      const evaluation={status:'approved',rejectCode:null,policyHash:'a'.repeat(64),rules:[],approvedActions:[]}
      await c.execute('INSERT INTO risk_decisions_v4 VALUES (?,?,?,?,\'approved\',NULL,?,1,NULL,1,1)',[risk,decision,scope.userId,scope.route.accountId,evaluation.policyHash])
      await c.execute('INSERT INTO risk_decision_payloads_v4 VALUES (?,?,?)',[risk,JSON.stringify(evaluation),contentHash(evaluation)])
    }
    await c.beginTransaction()
    await c.execute("UPDATE account_trade_records_v4 SET source_classification='unknown',attribution_status='unresolved' WHERE id=?",[scope.recordId])
    await c.execute("UPDATE strategies SET kind='trader' WHERE id=1")
    const [[record]]=await c.execute('SELECT revision FROM account_trade_records_v4 WHERE id=?',[scope.recordId])
    const collector=createTransactionSystemTradeReviewCollector(c)
    const input={userId:scope.userId,recordId:scope.recordId,expectedRevision:Number(record.revision),taskId:scope.taskId,route:scope.route,asOfUtcMsc}
    queued=await collector.collect(input)
    assert.equal(queued.status,'queued',JSON.stringify(queued))
    const [[changed]]=await c.execute('SELECT revision FROM account_trade_records_v4 WHERE id=?',[scope.recordId])
    assert.equal((await collector.collect({...input,expectedRevision:Number(changed.revision)})).status,'unchanged')
    const periodInventory=createMysqlPeriodTradeInventory(c)
    const periodScope={taskId:scope.taskId,route:scope.route,startUtcMsc:facts[0].occurredAtUtcMsc-100,endUtcMsc:facts.at(-1).occurredAtUtcMsc+1,asOfUtcMsc}
    const coveredPeriod=await periodInventory.read(periodScope)
    assert.equal(coveredPeriod.status,'captured')
    assert.equal(coveredPeriod.inventory.records.length,1)
    assert.equal(coveredPeriod.inventory.records[0].source,'system')
    await c.query('SAVEPOINT period_missing_exit')
    await c.execute(`DELETE x FROM account_trade_record_deals_v4 x JOIN terminal_history_deals_v4 d ON d.id=x.terminal_deal_id
      WHERE x.trade_record_id=? AND d.deal_ticket=?`,[scope.recordId,facts[1].ticket])
    assert.equal((await periodInventory.read(periodScope)).reason,'period_closing_deal_unrepresented')
    await c.query('ROLLBACK TO SAVEPOINT period_missing_exit')
    await c.commit()
  } catch(error){try{await c.rollback()}catch{destroyed=true;c.destroy()}throw error}
  finally {if(!destroyed){try{for(const name of created.reverse())await c.query(`DROP TEMPORARY TABLE ${name}`)}finally{c.release()}}}
  const outbox=new MysqlOutboxRepository(pool),deadline=Date.now()+15000
  let event
  while(!event&&Date.now()<deadline){event=(await outbox.claim('system-reference',100,30,new Date())).find(e=>e.eventType==='review.job.requested'&&e.payload.review_case_id===queued.caseId)
    if(!event)await new Promise(resolve=>setTimeout(resolve,250))}
  assert.ok(event)
  const result=await verifyCollectedReviewResult(admin,pool,scope,event,'system')
  return {passed:true,adapters:'actual-bootstrap-sql-collector',executionAndInferenceRows:'synthetic-temporary-tables',model:result,
    checks:['two-deals-through-execution-and-decision-and-risk-adapters','actual-current-and-historical-ownership','one-committed-case-and-job','collector-replay-no-duplicate','system-result-through-model-worker-and-http','period-inventory-includes-system-trade-and-rejects-unrepresented-exit']}
}
