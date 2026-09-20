import assert from 'node:assert/strict'
import {createMysqlExecutionPositionCollectionReader} from '../../server/dist-v4/modules/trading/composition.js'
import {createPartialCloseProjectionReader} from '../../server/dist-v4/bootstrap/partial-close-progress.js'
import {evaluatePartialCloseProtection} from '../../server/dist-v4/modules/execution/domain/partial-close-protection.js'
import {positionProtectionRequest,preparePositionProtectionChild} from '../../server/dist-v4/modules/execution/domain/position-protection-child.js'
import {DEFAULT_RISK_POLICY,resolveRiskPolicy,evaluatePositionProtection} from '../../server/dist-v4/modules/risk/index.js'
import {randomUUID} from 'node:crypto'
import {verifyBoundChildPersistence} from './bound-child-persistence-reference.mjs'

/** Same SQL connection as the persisted parent receipt and actual collected history. */
export async function verifyCollectedHistoryPositionChain(db,route,sourcePlan,historyReader){
 const [[identity]]=await db.query('SELECT DATABASE() db');assert.match(identity.db,/^dev_vue_history_ref_[a-f0-9]{32}$/)
 const [[session]]=await db.query('SELECT @@session.time_zone zone');await db.query("SET SESSION time_zone='+00:00'")
 const tables=[],create=async(name,columns)=>{await db.query(`CREATE TEMPORARY TABLE ${name} (${columns}) ENGINE=InnoDB`);tables.push(name)}
 try{
  await create('user_trading_account_settings','user_id INT,trading_account_id BIGINT,connection_paused TINYINT')
  await create('bridge_connection_sessions','user_id INT,trading_account_id BIGINT,terminal_profile_id VARCHAR(128),terminal_instance_id VARCHAR(128),connection_epoch_v4 BIGINT,connection_epoch VARCHAR(128),disconnected_at_utc DATETIME(3),last_seen_at_utc DATETIME(3)')
  await create('trading_account_ownerships','user_id INT,trading_account_id BIGINT,interval_id VARCHAR(36),revision BIGINT,role VARCHAR(32),revoked_at_utc DATETIME(3)')
  await create('trading_projection_revisions','trading_account_id BIGINT,resource_kind VARCHAR(32),resource_id VARCHAR(32),revision BIGINT')
  await create('trading_projection_provenance_v4','trading_account_id BIGINT,resource_kind VARCHAR(32),resource_id VARCHAR(32),projection_revision BIGINT,user_id INT,ownership_interval_id VARCHAR(36),ownership_revision BIGINT,terminal_profile_id VARCHAR(128),terminal_instance_id VARCHAR(128),connection_epoch BIGINT,observed_at_utc DATETIME(3)')
  await create('open_position_snapshots','trading_account_id BIGINT,ticket VARCHAR(64),revision BIGINT,payload_json JSON')
  await db.execute('INSERT INTO user_trading_account_settings VALUES (?,?,0)',[route.userId,route.accountId])
  await db.execute('INSERT INTO bridge_connection_sessions VALUES (?,?,?,?,?,?,NULL,UTC_TIMESTAMP(3))',[route.userId,route.accountId,route.terminalProfileId,route.terminalInstanceId,route.connectionEpoch,'v4:'+route.connectionId])
  await db.execute("INSERT INTO trading_account_ownerships VALUES (?,?,'interval',?,'owner',NULL)",[route.userId,route.accountId,route.ownershipRevision])
  await db.execute("INSERT INTO trading_projection_revisions VALUES (?,'positions','open',6)",[route.accountId])
  await db.execute("INSERT INTO trading_projection_provenance_v4 VALUES (?,'positions','open',6,?,'interval',?,?,?,?,UTC_TIMESTAMP(3))",[route.accountId,route.userId,route.ownershipRevision,route.terminalProfileId,route.terminalInstanceId,route.connectionEpoch])
  const item={accountId:route.accountId,ticket:sourcePlan.target.ticket,positionIdentifier:sourcePlan.target.positionIdentifier,symbol:'XAUUSD',side:'buy',volume:'1',revision:6,stopLoss:null,takeProfit:null}
  await db.execute('INSERT INTO open_position_snapshots VALUES (?,?,6,?)',[route.accountId,item.ticket,JSON.stringify(item)])
  const collectionReader=createMysqlExecutionPositionCollectionReader(db,{async assert(actual){assert.deepEqual(actual,route)}})
  const projectionReader=createPartialCloseProjectionReader(collectionReader,route,30000)
  const [[startClock]]=await db.query('SELECT UNIX_TIMESTAMP(UTC_TIMESTAMP(3))*1000 at')
  const plan={...sourcePlan,expiresAt:Number(startClock.at)+30000}
  const evaluate=async()=>{
   const [[clock]]=await db.query('SELECT UNIX_TIMESTAMP(UTC_TIMESTAMP(3))*1000 at')
   const now=Number(clock.at)
   const history=await historyReader.read(plan),projection=await projectionReader.read(plan)
   return evaluatePartialCloseProtection({plan,parentState:'succeeded',history,projection,now,maxProjectionAgeMs:30000})
  }
  let childBinding, boundInput
  await db.beginTransaction()
  try{
   const ready=await evaluate();assert.equal(ready.state,'risk_review_required');assert.equal(ready.remainingVolume,'1')
   const request=positionProtectionRequest(plan,ready,2)
   const snapshot=await collectionReader.read({route,maxAgeMs:30000});assert.ok(snapshot)
   const position=snapshot.positions.find(value=>value.ticket===request.target.ticket);assert.ok(position)
   const [[clock]]=await db.query('SELECT UNIX_TIMESTAMP(UTC_TIMESTAMP(3))*1000 at')
   const now=new Date(Number(clock.at)),observedAt=now.toISOString()
   const policy=resolveRiskPolicy({userId:route.userId,accountId:route.accountId,platformPolicyVersionId:'1',accountPolicyVersionId:null,policySetRevision:1,
    platform:{values:{...DEFAULT_RISK_POLICY},globalKillSwitch:false,revision:1},account:{tradeSendEnabled:true},updatedAt:observedAt})
   const summary={accountId:route.accountId,userId:route.userId,businessDate:observedAt.slice(0,10),equity:'10000',freeMargin:'9000',marginLevelPercent:1000,
    dailyLossPercent:1,drawdownPercent:1,openPositions:1,pendingOrders:0,totalVolume:'1',dailyOpenCount:1,consecutiveLosses:0,
    terminalTimezoneOffsetMinutes:180,clockStatus:'calibrated',lastSuccessfulOpenAt:null,cooldownUntil:null,dataComplete:true,incompleteReasons:[],observedAt,revision:4}
   const context={userId:route.userId,accountId:route.accountId,authorized:true,connectionPaused:false,tradePermission:true,accountObservedAt:observedAt,
    collectionComplete:true,policy,summary,quote:{symbol:'XAUUSD',bid:'2500',ask:'2500.1',revision:8,observedAt},
    instrument:{symbol:'XAUUSD',point:'0.01',tickSize:'0.01',tradeEnabled:true,revision:3,observedAt,maxAgeMs:300000},
    position:{...request.target,volume:position.volume,stopLoss:position.stopLoss,takeProfit:position.takeProfit,revision:snapshot.revision,observedAt:snapshot.observedAt},
    revisions:{account:2,positions:snapshot.revision,quote:8,contract:3,risk:4}}
   const review=evaluatePositionProtection(request,context,now);assert.equal(review.evaluation.status,'approved')
   const input={plan,ready,revision:2,parentOperationId:randomUUID(),review,now}
   boundInput=structuredClone(input)
   const child=preparePositionProtectionChild(input)
   assert.equal(child.intent.action.kind,'modify_position');assert.deepEqual(child.intent.action.parameters,{ticket:plan.target.ticket,stop_loss:plan.protection.stopLoss})
   assert.deepEqual(preparePositionProtectionChild(input),child)
   const halted=evaluatePositionProtection(request,{...context,policy:{...policy,globalKillSwitch:true}},now)
   assert.equal(halted.evaluation.status,'rejected')
   assert.throws(()=>preparePositionProtectionChild({...input,review:halted}),/position_protection_review_mismatch/)
   childBinding={passed:true,checks:['SQL-eligibility-to-deterministic-review-and-bound-child','same-evidence-rebuilds-identical-child','current-kill-switch-prevents-child'],
    position:'actual-SQL-collection',otherRiskFacts:'synthetic-context',persisted:false}
  }finally{await db.rollback()}
  for(const [sql,expected,reason] of [
   ["UPDATE trading_projection_provenance_v4 SET connection_epoch=connection_epoch+1",'wait_projection',null],
   ["UPDATE open_position_snapshots SET revision=5",'wait_projection',null],
   ["UPDATE open_position_snapshots SET payload_json=JSON_SET(payload_json,'$.volume','0.5')",'stopped','remaining_volume_mismatch'],
   ["UPDATE trading_account_ownerships SET revoked_at_utc=UTC_TIMESTAMP(3)",'wait_projection',null],
  ]){await db.beginTransaction();try{await db.query(sql);const result=await evaluate();assert.equal(result.state,expected);if(reason)assert.equal(result.reason,reason)}finally{await db.rollback()}}
  const persistence=await verifyBoundChildPersistence(db,boundInput)
  return {passed:true,childBinding,persistence,checks:['same-connection-SQL-receipt-collected-history-and-current-position-eligibility',
   'wrong-source-epoch-mixed-revision-or-revoked-owner-prevent-eligibility','changed-residual-volume-stops-protection'],
   routeGuard:'injected-exact-route',projection:'actual-SQL-reader-on-synthetic-query-tables',childPrepared:false}
 }finally{await db.rollback();for(const name of tables.reverse())await db.query(`DROP TEMPORARY TABLE ${name}`);await db.execute('SET SESSION time_zone=?',[session.zone])}
}
