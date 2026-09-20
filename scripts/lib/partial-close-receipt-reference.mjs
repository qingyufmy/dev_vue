import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createMysqlPartialCloseReceiptReader } from '../../server/dist-v4/modules/execution/composition.js'
import { canonicalHash } from '../../server/dist-v4/modules/execution/domain/bridge-command.js'

export async function verifyPartialCloseReceiptReference(db) {
  const [[identity]]=await db.query('SELECT DATABASE() db')
  assert.match(identity.db,/^dev_vue_strategy_ref_[a-f0-9]{32}$/)
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
    const target={userId:'7',accountId:'5',terminalInstanceId:'terminal',brokerServer:'Broker',login:'42',positionIdentifier:'100',ticket:'101',symbol:'XAUUSD',side:'buy'}
    const issued=Date.parse('2026-09-10T10:00:00.001Z'),completed=issued+123
    const plan={workflowId:randomUUID(),parentIntentId:randomUUID(),parentCommandId:randomUUID(),target,
      initialVolume:'0.10',closeVolume:'0.08',initialRevision:5,expiresAt:completed+10000,protection:{stopLoss:'2400'}}
    const request={v:4,type:'command.request',correlation_id:plan.parentIntentId,
      route:{terminal_instance_id:'terminal',account_ref:{broker_server:'Broker',login:'42'},connection_epoch:1},
      payload:{command_id:plan.parentCommandId,action:'position.close',issued_at_utc_msc:issued,params:{ticket:'101',volume:'0.08'},
        expected_state:{ticket:'101',symbol:'XAUUSD',direction:'buy',volume:'0.10'}}}
    const result={raw_result:{order:201,deal:301,position:101},evidence:{order_tickets:['201'],deal_tickets:['301'],position_tickets:['101']}}
    const payload={command_id:plan.parentCommandId,action:'position.close',status:'succeeded',completed_at_utc_msc:completed,result,error_code:null,terminal_code:10009}
    const hash=canonicalHash(payload),message='result:'+plan.parentCommandId
    await db.execute('INSERT INTO execution_intents VALUES (?,7,5,?,?)',[plan.parentIntentId,'close_position','succeeded'])
    await db.execute('INSERT INTO bridge_commands_v4 VALUES (?,?,7,5,?,?,?,?,?,1,?,?,?,?,?)',
      [plan.parentCommandId,plan.parentIntentId,'position.close','succeeded','terminal','Broker','42',canonicalHash(request.payload),hash,message,new Date(issued),new Date(completed)])
    await db.execute('INSERT INTO bridge_command_payloads_v4 VALUES (?,?)',[plan.parentCommandId,JSON.stringify(request)])
    await db.execute('INSERT INTO bridge_command_results_v4 VALUES (?,?,?,?,?,0,?,?,NULL,?)',
      [plan.parentCommandId,message,hash,'position.close','succeeded',new Date(completed),JSON.stringify(result),'10009'])
    const reader=createMysqlPartialCloseReceiptReader(db)
    await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
    try {
      const receipt=await reader.read(plan)
      assert.equal(receipt.orderTicket,'201');assert.deepEqual(receipt.dealTickets,['301']);assert.equal(receipt.completedAt,completed)
      assert.equal(receipt.resultHash,hash)
      checks.push('read-only-snapshot-exact-parent-current-result-message-and-numeric-terminal-code-hash')
    }finally{await db.rollback()}
    for(const [name,sql] of [
      ['intent-other-user','UPDATE execution_intents SET user_id=8'],
      ['intent-other-account','UPDATE execution_intents SET trading_account_id=6'],
      ['intent-not-succeeded',"UPDATE execution_intents SET status='uncertain'"],
      ['intent-wrong-action',"UPDATE execution_intents SET action_kind='modify_position'"],
      ['command-other-user','UPDATE bridge_commands_v4 SET user_id=8'],
      ['command-other-account','UPDATE bridge_commands_v4 SET trading_account_id=6'],
      ['command-not-succeeded',"UPDATE bridge_commands_v4 SET status='uncertain'"],
      ['command-wrong-action',"UPDATE bridge_commands_v4 SET action='order.place'"],
      ['terminal-mismatch',"UPDATE bridge_commands_v4 SET terminal_instance_id='other'"],
      ['broker-case-mismatch',"UPDATE bridge_commands_v4 SET broker_server='broker'"],
      ['login-mismatch',"UPDATE bridge_commands_v4 SET account_login='042'"],
      ['non-current-result-message',"UPDATE bridge_commands_v4 SET result_message_id='other'"],
      ['non-current-result-hash',"UPDATE bridge_commands_v4 SET result_sha256=REPEAT('0',64)"],
      ['conflicting-result','UPDATE bridge_command_results_v4 SET conflict=1'],
      ['result-not-succeeded',"UPDATE bridge_command_results_v4 SET status='uncertain'"],
      ['result-wrong-action',"UPDATE bridge_command_results_v4 SET action='order.place'"],
    ]){
      await db.beginTransaction()
      try{await db.query(sql);assert.equal(await reader.read(plan),null,name);checks.push(name)}finally{await db.rollback()}
    }
    for(const [name,sql] of [
      ['stored-result-corrupt',"UPDATE bridge_command_results_v4 SET result_json=JSON_SET(result_json,'$.raw_result.order',202)"],
      ['terminal-code-corrupt',"UPDATE bridge_command_results_v4 SET terminal_code='10010'"],
      ['completion-time-mismatch','UPDATE bridge_command_results_v4 SET completed_at_utc=completed_at_utc+INTERVAL 1 SECOND'],
      ['request-corrupt',"UPDATE bridge_command_payloads_v4 SET request_envelope_json=JSON_SET(request_envelope_json,'$.payload.params.volume','0.07')"],
      ['command-epoch-mismatch','UPDATE bridge_commands_v4 SET connection_epoch=2'],
      ['success-with-error',"UPDATE bridge_command_results_v4 SET error_code='failed'"],
    ]){
      await db.beginTransaction()
      try{await db.query(sql);await assert.rejects(reader.read(plan),/partial_close_receipt_corrupt/);checks.push(name)}finally{await db.rollback()}
    }
    for(const terminalCode of [undefined,null,'10009',10009.5]){
      await db.beginTransaction()
      try{
        const value={...payload};delete value.terminal_code
        if(terminalCode!==undefined)value.terminal_code=terminalCode
        const digest=canonicalHash(value)
        await db.execute('UPDATE bridge_commands_v4 SET result_sha256=?',[digest])
        await db.execute('UPDATE bridge_command_results_v4 SET result_sha256=?,terminal_code=?',[digest,terminalCode==null?null:String(terminalCode)])
        assert.equal((await reader.read(plan)).resultHash,digest)
      }finally{await db.rollback()}
    }
    checks.push('wire-optional-null-string-and-number-terminal-code-encodings-reconstructed-by-original-hash')
    await db.beginTransaction()
    try{
      const value={...payload,result:{raw_result:{already_absent:true,position:101},evidence:{order_tickets:[],deal_tickets:[]}}}
      const digest=canonicalHash(value)
      await db.execute('UPDATE bridge_commands_v4 SET result_sha256=?',[digest])
      await db.execute('UPDATE bridge_command_results_v4 SET result_sha256=?,result_json=?',[digest,JSON.stringify(value.result)])
      assert.equal(await reader.read(plan),null)
      checks.push('already-absent-success-is-not-close-execution-proof')
    }finally{await db.rollback()}
    return {passed:true,checks,querySchema:'minimal-temporary-scaffolds',foreignKeysVerified:false,historyProofVerified:false,realTerminalVerified:false}
  }finally{
    await db.rollback()
    for(const table of tables.reverse())await db.query(`DROP TEMPORARY TABLE ${table}`)
  }
}
