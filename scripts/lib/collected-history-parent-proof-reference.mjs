import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createMysqlPartialCloseReceiptReader } from '../../server/dist-v4/modules/execution/composition.js'
import { createMysqlClosedOrderHistoryReader } from '../../server/dist-v4/modules/trade-history/composition.js'
import { createPartialCloseHistoryProofReader } from '../../server/dist-v4/bootstrap/partial-close-history-proof.js'
import { canonicalHash } from '../../server/dist-v4/modules/execution/domain/bridge-command.js'
import {verifyCollectedHistoryPositionChain} from './collected-history-position-chain-reference.mjs'

export async function verifyCollectedHistoryParentProof(db,route,window) {
  const [[identity]]=await db.query('SELECT DATABASE() db')
  assert.match(identity.db,/^dev_vue_history_ref_[a-f0-9]{32}$/)
  const tables=[],checks=[],idType='VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin'
  const create=async(name,columns)=>{await db.query(`CREATE TEMPORARY TABLE ${name} (${columns}) ENGINE=InnoDB`);tables.push(name)}
  try {
    await create('execution_intents',`id ${idType} PRIMARY KEY,user_id INT,trading_account_id BIGINT,action_kind VARCHAR(64),status VARCHAR(32)`)
    await create('bridge_commands_v4',`id ${idType} PRIMARY KEY,execution_intent_id ${idType},user_id INT,trading_account_id BIGINT,action VARCHAR(64),status VARCHAR(32),
      terminal_instance_id VARCHAR(128),broker_server VARCHAR(128),account_login VARCHAR(64),connection_epoch BIGINT,request_sha256 CHAR(64),result_sha256 CHAR(64),
      result_message_id ${idType},issued_at_utc DATETIME(3),completed_at_utc DATETIME(3)`)
    await create('bridge_command_payloads_v4',`bridge_command_id ${idType} PRIMARY KEY,request_envelope_json JSON`)
    await create('bridge_command_results_v4',`bridge_command_id ${idType},message_id ${idType},result_sha256 CHAR(64),action VARCHAR(64),status VARCHAR(32),
      conflict TINYINT,completed_at_utc DATETIME(3),result_json JSON,error_code VARCHAR(128),terminal_code VARCHAR(128)`)
    const target={userId:String(route.userId),accountId:route.accountId,terminalInstanceId:route.terminalInstanceId,brokerServer:route.brokerServer,login:route.login,positionIdentifier:'60000',ticket:'60010',symbol:'XAUUSD',side:'buy'}
    const issued=window.rangeStartUtcMsc+150,completed=window.rangeStartUtcMsc+250
    const plan={workflowId:randomUUID(),parentIntentId:randomUUID(),parentCommandId:randomUUID(),target,
      initialVolume:'2',closeVolume:'1',initialRevision:5,expiresAt:completed+10000,protection:{stopLoss:'2400'}}
    const request={v:4,type:'command.request',correlation_id:plan.parentIntentId,
      route:{terminal_instance_id:route.terminalInstanceId,account_ref:{broker_server:route.brokerServer,login:route.login},connection_epoch:route.connectionEpoch},
      payload:{command_id:plan.parentCommandId,action:'position.close',issued_at_utc_msc:issued,params:{ticket:'60010',volume:'1'},
        expected_state:{ticket:'60010',symbol:'XAUUSD',direction:'buy',volume:'2'}}}
    const result={raw_result:{order:61002,deal:60002,position:60010},evidence:{order_tickets:['61002'],deal_tickets:['60002'],position_tickets:['60010']}}
    const payload={command_id:plan.parentCommandId,action:'position.close',status:'succeeded',completed_at_utc_msc:completed,result,error_code:null,terminal_code:10009}
    const hash=canonicalHash(payload),message='result:'+plan.parentCommandId
    await db.execute('INSERT INTO execution_intents VALUES (?,?,?,?,?)',[plan.parentIntentId,route.userId,route.accountId,'close_position','succeeded'])
    await db.execute('INSERT INTO bridge_commands_v4 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [plan.parentCommandId,plan.parentIntentId,route.userId,route.accountId,'position.close','succeeded',route.terminalInstanceId,route.brokerServer,route.login,route.connectionEpoch,canonicalHash(request.payload),hash,message,new Date(issued).toISOString().replace('T',' ').replace('Z',''),new Date(completed).toISOString().replace('T',' ').replace('Z','')])
    await db.execute('INSERT INTO bridge_command_payloads_v4 VALUES (?,?)',[plan.parentCommandId,JSON.stringify(request)])
    await db.execute('INSERT INTO bridge_command_results_v4 VALUES (?,?,?,?,?,0,?,?,NULL,?)',
      [plan.parentCommandId,message,hash,'position.close','succeeded',new Date(completed).toISOString().replace('T',' ').replace('Z',''),JSON.stringify(result),'10009'])
    const reader=createPartialCloseHistoryProofReader(createMysqlPartialCloseReceiptReader(db),createMysqlClosedOrderHistoryReader(db),route)
    await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
    try{
      const proof=await reader.read(plan)
      assert.ok(proof);assert.equal(proof.closedVolume,'1');assert.equal(proof.evidence.resultHash,hash)
      assert.equal(proof.evidence.orderTicket,'61002');assert.equal(proof.evidence.taskId,window.taskId)
      assert.deepEqual(proof.evidence.deals.map(deal=>deal.ticket),['60002'])
      assert.ok(proof.evidence.deals[0].provenanceHashes.length>0)
      checks.push('SQL-parent-receipt-to-actual-collected-task-pages-deals-and-provenance')
    }finally{await db.rollback()}
    await db.beginTransaction()
    try{
      await db.query("UPDATE terminal_history_deal_provenance_v4 p JOIN terminal_history_deals_v4 d ON d.id=p.terminal_history_deal_id SET p.source_revision='other' WHERE d.deal_ticket='60002'")
      assert.equal(await reader.read(plan),null)
      checks.push('receipt-and-volume-do-not-bypass-history-source-membership')
    }finally{await db.rollback()}
    const positionChain=await verifyCollectedHistoryPositionChain(db,route,plan,reader)
    return {passed:true,checks,positionChain,receipt:'synthetic-parent-record-through-actual-SQL-reader',history:'actual-queued-collector-tables',routeGuard:'caller-supplied-reference-route',terminalVerified:false}
  }finally{await db.rollback();for(const name of tables.reverse())await db.query(`DROP TEMPORARY TABLE ${name}`)}
}
