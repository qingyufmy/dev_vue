import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {contentHash} from '../../server/dist-v4/modules/inference/domain/inference.js'

/** Owned query fixtures in the isolated reference database, not production DDL or authorization evidence. */
export async function withReferenceEntrySqlFixture(connection, scope, work) {
  const [[identity]]=await connection.query('SELECT DATABASE() db')
  assert.match(identity.db,/^dev_vue_history_ref_[a-f0-9]{32}$/)
  const created=[]
  const definitions={
    trade_decisions:'id CHAR(36),risk_decision_id CHAR(36),user_id INT,trading_account_id BIGINT,strategy_id BIGINT,strategy_version_id BIGINT,market_analysis_id CHAR(36),trader_run_id CHAR(36),input_snapshot_id CHAR(36),status VARCHAR(20)',
    ai_trader_runs:'id CHAR(36),user_id INT,trading_account_id BIGINT,strategy_id BIGINT,strategy_version_id BIGINT,market_analysis_id CHAR(36),input_snapshot_id CHAR(36),status VARCHAR(20)',
    market_analyses:'id CHAR(36),owner_scope VARCHAR(20),owner_user_id INT,analysis_run_id CHAR(36),strategy_id BIGINT,strategy_version_id BIGINT,standard_symbol VARCHAR(64),input_snapshot_id CHAR(36),content_sha256 CHAR(64)',
    ai_analysis_runs:'id CHAR(36),user_id INT,strategy_id BIGINT,strategy_version_id BIGINT,standard_symbol VARCHAR(64),input_snapshot_id CHAR(36),status VARCHAR(20),market_source_account_id BIGINT',
    inference_snapshots:'id CHAR(36),user_id INT,trading_account_id BIGINT NULL,strategy_id BIGINT,strategy_version_id BIGINT,standard_symbol VARCHAR(64),purpose VARCHAR(20),payload_sha256 CHAR(64)',
    inference_snapshot_payloads:'snapshot_id CHAR(36),encoding VARCHAR(20),payload_json JSON',
    market_analysis_payloads:'market_analysis_id CHAR(36),payload_sha256 CHAR(64),payload_json JSON',
    execution_intents:'id CHAR(36),operation_id CHAR(36),action_kind VARCHAR(32),user_id INT,trading_account_id BIGINT,source_type VARCHAR(32),source_id CHAR(36),risk_decision_id CHAR(36),trade_decision_id CHAR(36),status VARCHAR(20)',
    execution_outcomes:'execution_intent_id CHAR(36),trading_account_id BIGINT,result_sha256 CHAR(64),result_json JSON,distribution_target_id CHAR(36),status VARCHAR(20)',
    bridge_commands_v4:'execution_intent_id CHAR(36),user_id INT,trading_account_id BIGINT,result_sha256 CHAR(64),status VARCHAR(20),action VARCHAR(32),terminal_instance_id VARCHAR(64),connection_epoch BIGINT,broker_server VARCHAR(128),account_login VARCHAR(64)',
    execution_distribution_targets:'id CHAR(36),target_user_id INT,trading_account_id BIGINT,child_operation_id CHAR(36),distribution_id CHAR(36)',
    execution_distributions:'id CHAR(36),strategy_id BIGINT,kind VARCHAR(32)',
  }
  const insert=(table,row)=>{
    assert.ok(Object.hasOwn(definitions,table))
    return connection.execute(`INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(()=>'?').join(',')})`,Object.values(row))
  }
  const ids=Object.fromEntries(['decision','risk','analysis','analysisRun','traderRun','analysisInput','traderInput'].map(key=>[key,randomUUID()]))
  const result={marketBias:'bullish',opportunity:'long_setup',confidence:80,summary:'historical entry',marketRegime:'trend',
    supportingEvidence:[],counterEvidence:[],dataGaps:[],keyLevels:{support:['2500']},invalidation:{},analysisBody:'frozen historical analysis',
    analyzedAt:'2020-01-01T00:01:00.000Z',validUntil:'2020-01-01T00:10:00.000Z'}
  const analysis={kind:'analysis',strategy:{id:'20',versionId:'201'},market:{symbol:'XAUUSD',source_account_id:scope.accountId},capturedAt:'2020-01-01T00:00:00.000Z'}
  const trader={kind:'trader',strategy:{id:'21',versionId:'211'},account:{id:scope.accountId},capturedAt:'2020-01-01T00:02:00.000Z',
    analysis:{id:ids.analysis,contentHash:contentHash(result),result}}
  try{
    for(const [table,columns] of Object.entries(definitions)){
      // The actual query joins snapshots twice; MySQL temporary tables cannot be reopened.
      // CREATE without IF NOT EXISTS refuses to adopt any pre-existing table.
      await connection.query(`CREATE TABLE ${table} (${columns}) ENGINE=InnoDB`);created.push(table)
    }
    const base={user_id:scope.userId,trading_account_id:scope.accountId,strategy_id:'21',strategy_version_id:'211',market_analysis_id:ids.analysis,input_snapshot_id:ids.traderInput,status:'succeeded'}
    await insert('ai_trader_runs',{id:ids.traderRun,...base})
    await insert('trade_decisions',{id:ids.decision,...base,status:'accepted',risk_decision_id:ids.risk,trader_run_id:ids.traderRun})
    await insert('ai_analysis_runs',{id:ids.analysisRun,user_id:scope.userId,strategy_id:'20',strategy_version_id:'201',standard_symbol:'XAUUSD',input_snapshot_id:ids.analysisInput,status:'succeeded',market_source_account_id:scope.accountId})
    await insert('market_analyses',{id:ids.analysis,owner_scope:'user',owner_user_id:scope.userId,analysis_run_id:ids.analysisRun,strategy_id:'20',strategy_version_id:'201',standard_symbol:'XAUUSD',input_snapshot_id:ids.analysisInput,content_sha256:contentHash(result)})
    await insert('market_analysis_payloads',{market_analysis_id:ids.analysis,payload_sha256:contentHash(result),payload_json:JSON.stringify(result)})
    for(const [id,payload] of [[ids.analysisInput,analysis],[ids.traderInput,trader]]){
      await insert('inference_snapshots',{id,user_id:scope.userId,trading_account_id:payload.kind==='analysis'?null:scope.accountId,strategy_id:payload.strategy.id,strategy_version_id:payload.strategy.versionId,standard_symbol:'XAUUSD',purpose:payload.kind,payload_sha256:contentHash(payload)})
      await insert('inference_snapshot_payloads',{snapshot_id:id,encoding:'json',payload_json:JSON.stringify(payload)})
    }
    const intentId=randomUUID(),executionResult={order_ticket:'61001'},resultHash=contentHash(executionResult)
    await insert('execution_intents',{id:intentId,operation_id:randomUUID(),action_kind:'market_order',user_id:scope.userId,trading_account_id:scope.accountId,
      source_type:'risk_decision',source_id:ids.risk,risk_decision_id:ids.risk,trade_decision_id:ids.decision,status:'succeeded'})
    await insert('execution_outcomes',{execution_intent_id:intentId,trading_account_id:scope.accountId,result_sha256:resultHash,result_json:JSON.stringify(executionResult),distribution_target_id:null,status:'succeeded'})
    await insert('bridge_commands_v4',{execution_intent_id:intentId,user_id:scope.userId,trading_account_id:scope.accountId,result_sha256:resultHash,status:'succeeded',action:'order.place',
      terminal_instance_id:scope.route.terminalInstanceId,connection_epoch:scope.route.connectionEpoch,broker_server:scope.route.brokerServer,account_login:scope.route.login})
    return await work({ids,result,creationDecision:{decisionId:ids.decision,riskDecisionId:ids.risk,strategyVersionId:'211'}})
  }finally{
    await connection.rollback()
    for(const table of created.reverse())await connection.query(`DROP TABLE ${table}`)
  }
}
