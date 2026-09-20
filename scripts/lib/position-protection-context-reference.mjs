import assert from 'node:assert/strict'
import {createPositionProtectionReviewCapture} from '../../server/dist-v4/bootstrap/position-protection-preparation.js'
import {createTransactionPartialCloseDispatchReviewer} from '../../server/dist-v4/bootstrap/partial-close-dispatch-review.js'
import {createMysqlPositionProtectionClock} from '../../server/dist-v4/modules/risk/composition.js'
import {DEFAULT_RISK_POLICY} from '../../server/dist-v4/modules/risk/index.js'
import {normalizeInstrumentProjection} from '../../server/dist-v4/modules/trading/domain/instrument-projection.js'
import {preparePositionProtectionChild} from '../../server/dist-v4/modules/execution/index.js'

/** Actual authorization and all reviewer SQL on caller's temporary query scaffolds; no terminal or child-intent writes. */
export async function verifyPositionProtectionContext(db,route) {
  const [[identity]]=await db.query('SELECT DATABASE() db');assert.match(identity.db,/^dev_vue_strategy_ref_[a-f0-9]{32}$/)
  const tables=[],checks=[]
  const create=async(name,columns)=>{await db.query(`CREATE TEMPORARY TABLE ${name} (${columns}) ENGINE=InnoDB`);tables.push(name)}
  try {
    await create('account_runtime_snapshots','trading_account_id BIGINT,trade_permission TINYINT,timezone_offset_minutes INT,clock_status VARCHAR(32),revision BIGINT,observed_at_utc DATETIME(3)')
    await create('market_quotes','trading_account_id BIGINT,symbol VARCHAR(64),bid DECIMAL(47,18),ask DECIMAL(47,18),revision BIGINT,observed_at_utc DATETIME(3)')
    await create('market_instrument_snapshots','trading_account_id BIGINT,symbol VARCHAR(64),payload_json JSON,revision BIGINT,observed_at_utc DATETIME(3)')
    await create('account_risk_states','trading_account_id BIGINT,user_id INT,revision BIGINT,observed_at_utc DATETIME(3)')
    await create('account_risk_summaries','trading_account_id BIGINT,payload_json JSON,revision BIGINT,observed_at_utc DATETIME(3)')
    await create('risk_policy_sets_v4','id BIGINT,scope VARCHAR(32),owner_user_id INT,trading_account_id BIGINT,revision BIGINT,active_version_id BIGINT,status VARCHAR(32),updated_at_utc DATETIME(3)')
    await create('risk_policy_versions_v4','id BIGINT,policy_set_id BIGINT,policy_json JSON')
    await create('global_risk_controls','id INT,kill_switch TINYINT,revision BIGINT')
    let routeReads=0
    const bindReviewer=await createPositionProtectionReviewCapture({async current(){routeReads++;return route}}, {maxAgeMs:30000,maxInstrumentAgeMs:300000})({workflowId:'00000000-0000-8000-8000-000000000001',userId:7,accountId:'5'})
    assert.equal(routeReads,1)
    await db.beginTransaction()
    const now=await createMysqlPositionProtectionClock(db).now(),observedAt=now.toISOString(),sqlTime=observedAt.replace('T',' ').replace('Z','')
    await db.execute("INSERT INTO account_runtime_snapshots VALUES (5,1,180,'calibrated',2,?)",[sqlTime])
    await db.execute("INSERT INTO market_quotes VALUES (5,'XAUUSD','2500','2500.1',8,?)",[sqlTime])
    const raw={symbol:'XAUUSD',point:'0.01',tick_size:'0.01',tick_value:'1',volume_min:'0.01',volume_max:'10',volume_step:'0.01',trade_mode:4}
    const instrument={...normalizeInstrumentProjection(raw,'XAUUSD'),raw,sourceEvidence:{userId:7,ownershipRevision:'1',terminalProfileId:'profile',terminalInstanceId:'terminal-1',connectionEpoch:1,sourceRevision:'symbol-source',observedAt}}
    await db.execute("INSERT INTO market_instrument_snapshots VALUES (5,'XAUUSD',?,3,?)",[JSON.stringify(instrument),sqlTime])
    for(const [kind,id,revision] of [['account.metrics','current',2],['market.quote','XAUUSD',8]]) {
      await db.execute('INSERT INTO trading_projection_revisions VALUES (5,?,?,?)',[kind,id,revision])
      await db.execute("INSERT INTO trading_projection_provenance_v4 VALUES (5,?,?,?,7,'interval',1,'profile','terminal-1',1,?)",[kind,id,revision,sqlTime])
    }
    await db.query("UPDATE trading_projection_revisions SET revision=6 WHERE resource_kind='positions'")
    await db.execute("UPDATE trading_projection_provenance_v4 SET projection_revision=6,observed_at_utc=? WHERE resource_kind='positions'",[sqlTime])
    await db.query("UPDATE open_position_snapshots SET revision=6,payload_json=JSON_SET(payload_json,'$.revision',6,'$.volume','0.02','$.stopLoss','2400','$.takeProfit',NULL)")
    const summary={accountId:'5',userId:7,businessDate:observedAt.slice(0,10),equity:'10000',freeMargin:'9000',marginLevelPercent:1000,dailyLossPercent:1,drawdownPercent:1,
      openPositions:1,pendingOrders:0,totalVolume:'0.02',dailyOpenCount:1,consecutiveLosses:0,terminalTimezoneOffsetMinutes:180,clockStatus:'calibrated',
      lastSuccessfulOpenAt:null,cooldownUntil:null,dataComplete:true,incompleteReasons:[],observedAt,revision:4}
    await db.execute('INSERT INTO account_risk_states VALUES (5,7,4,?)',[sqlTime]);await db.execute('INSERT INTO account_risk_summaries VALUES (5,?,4,?)',[JSON.stringify(summary),sqlTime])
    await db.execute("INSERT INTO risk_policy_sets_v4 VALUES (1,'platform',NULL,NULL,1,1,'active',?),(2,'account',7,5,1,2,'active',?)",[sqlTime,sqlTime])
    await db.execute('INSERT INTO risk_policy_versions_v4 VALUES (1,1,?),(2,2,?)',[JSON.stringify(DEFAULT_RISK_POLICY),JSON.stringify({tradeSendEnabled:true})])
    await db.query('INSERT INTO global_risk_controls VALUES (1,0,1)')
    const request={workflowId:'00000000-0000-8000-8000-000000000001',workflowRevision:2,userId:7,accountId:'5',
      target:{terminalInstanceId:'terminal-1',brokerServer:'Broker',login:'42',ticket:'101',positionIdentifier:'100',symbol:'XAUUSD',side:'buy'},
      remainingVolume:'0.02',minimumPositionRevision:6,notBefore:now.getTime()-1000,expiresAt:now.getTime()+30000,protection:{stopLoss:'2450'}}
    const reviewer=bindReviewer(db)
    const review=await reviewer.review(request)
    assert.equal(review.evaluation.status,'approved');assert.deepEqual(review.evaluation.approvedActions[0].expectedState,{accountRevision:2,positionsRevision:6,quoteRevision:8,contractRevision:3,riskRevision:4})
    checks.push('actual-bootstrap-review-with-account-positions-quote-contract-policy-summary-and-DB-clock-in-one-transaction')
    const parentRequest={workflowId:request.workflowId,userId:7,accountId:'5',target:request.target,
      initialVolume:'0.02',closeVolume:'0.01',positionRevision:6,notBefore:request.notBefore,expiresAt:request.expiresAt}
    const parentReviewer=createTransactionPartialCloseDispatchReviewer(db,route,{maxAgeMs:30000,maxInstrumentAgeMs:300000})
    const parentReview=await parentReviewer.review(parentRequest)
    assert.equal(parentReview.status,'approved');assert.equal(parentReview.volume,'0.01');assert.equal(parentReview.remainingVolume,'0.01')
    checks.push('parent-close-actual-SQL-context-and-volume-limits-approved-without-future-protection-action')
    for(const [name,sql,code] of [
      ['parent-global-kill',"UPDATE global_risk_controls SET kill_switch=1",'RISK_GLOBAL_KILL_SWITCH'],
      ['parent-permission',"UPDATE account_runtime_snapshots SET trade_permission=0",'RISK_PARTIAL_CLOSE_ACCESS_UNAVAILABLE'],
      ['parent-volume-changed',"UPDATE open_position_snapshots SET payload_json=JSON_SET(payload_json,'$.volume','0.03')",'RISK_PARTIAL_CLOSE_VOLUME_CHANGED'],
      ['parent-owner-revoked',"UPDATE trading_account_ownerships SET revoked_at_utc=UTC_TIMESTAMP(3)",null],
      ['parent-volume-source-tampered',"UPDATE market_instrument_snapshots SET payload_json=JSON_SET(payload_json,'$.volumeStep','0.02')",null],
    ]){
      await db.query('SAVEPOINT parent_review_case')
      try{await db.query(sql)
        if(code)assert.equal((await parentReviewer.review(parentRequest)).rejectCode,code)
        else await assert.rejects(()=>parentReviewer.review(parentRequest),error=>error.code==='partial_close_dispatch_context_unavailable')
        checks.push(name)
      }catch(error){error.referenceStatement=name;throw error}
      finally{await db.query('ROLLBACK TO SAVEPOINT parent_review_case');await db.query('RELEASE SAVEPOINT parent_review_case')}
    }
    const target={...request.target,userId:'7',accountId:'5'}
    const plan={workflowId:request.workflowId,parentIntentId:'22222222-2222-5222-a222-222222222222',parentCommandId:'confirmed-parent',
      target,initialVolume:'0.10',closeVolume:'0.08',initialRevision:5,expiresAt:request.expiresAt,protection:request.protection}
    const ready={state:'risk_review_required',workflowId:request.workflowId,target,remainingVolume:'0.02',projectionRevision:6,
      projectionObservedAt:request.notBefore,protection:request.protection}
    const childInput={plan,ready,revision:2,parentOperationId:'33333333-3333-5333-a333-333333333333',review,now:await createMysqlPositionProtectionClock(db).now()}
    const child=preparePositionProtectionChild(childInput)
    assert.equal(child.intent.sourceType,'position_workflow');assert.equal(child.intent.userCommandId,null)
    assert.deepEqual(child.intent.action,review.evaluation.approvedActions[0]);assert.equal(child.intent.sourceId,request.workflowId)
    assert.deepEqual(preparePositionProtectionChild(childInput),child)
    assert.throws(()=>preparePositionProtectionChild({...childInput,ready:{...ready,remainingVolume:'0.01'}}),/position_protection_review_mismatch/)
    checks.push('actual-SQL-review-to-bound-unique-child-model-replay-and-residual-mismatch-no-child-writes')
    for(const [name,sql,code] of [
      ['quote-other-connection',"UPDATE trading_projection_provenance_v4 SET connection_epoch=2 WHERE resource_kind='market.quote'",null],
      ['quote-revision-mixed',"UPDATE market_quotes SET revision=9",null],
      ['instrument-normalized-price-tampered',"UPDATE market_instrument_snapshots SET payload_json=JSON_SET(payload_json,'$.tickSize','0.001')",null],
      ['current-owner-revoked','UPDATE trading_account_ownerships SET revoked_at_utc=UTC_TIMESTAMP(3)',null],
      ['summary-clock-disagrees',"UPDATE account_risk_summaries SET payload_json=JSON_SET(payload_json,'$.terminalTimezoneOffsetMinutes',120)",null],
      ['global-kill-enforced','UPDATE global_risk_controls SET kill_switch=1','RISK_GLOBAL_KILL_SWITCH'],
      ['current-trade-permission-disabled','UPDATE account_runtime_snapshots SET trade_permission=0','RISK_PROTECTION_ACCESS_UNAVAILABLE'],
      ['remaining-position-volume-changed',"UPDATE open_position_snapshots SET payload_json=JSON_SET(payload_json,'$.volume','0.01')",'RISK_PROTECTION_VOLUME_CHANGED'],
      ['current-stop-must-not-widen',"UPDATE open_position_snapshots SET payload_json=JSON_SET(payload_json,'$.stopLoss','2460')",'RISK_PROTECTION_STOP_WIDENING'],
    ]) {
      await db.query('SAVEPOINT protection_case')
      try {
        await db.query(sql)
        if(code)assert.equal((await reviewer.review(request)).evaluation.rejectCode,code)
        else await assert.rejects(()=>reviewer.review(request),error=>error.code==='position_protection_context_unavailable')
        checks.push(name)
      }catch(error){error.referenceStatement=name;throw error}
      finally {await db.query('ROLLBACK TO SAVEPOINT protection_case');await db.query('RELEASE SAVEPOINT protection_case')}
    }
    assert.equal(routeReads,1)
    checks.push('captured-once-before-BEGIN-with-actual-transaction-bound-reviewer')
    return checks
  }finally{
    await db.rollback()
    for(const name of tables.reverse())await db.query(`DROP TEMPORARY TABLE ${name}`)
  }
}
