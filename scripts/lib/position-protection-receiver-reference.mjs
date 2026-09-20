import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import Redis from 'ioredis'
import {developmentRedisConnection} from './development-redis.mjs'
import {RedisAccountExecutionLeaseStore,createMysqlPositionProtectionReceiverScope} from '../../server/dist-v4/modules/execution/composition.js'
import {BridgeCommandService,createPositionProtectionReceivers,createPositionProtectionPreparationReceiver} from '../../server/dist-v4/modules/execution/index.js'

export async function verifyProtectionReceiverPreparation(pool,repository,input,scope,now) {
 const prefix='protection-prepare-reference-'+randomUUID().replaceAll('-',''),key=prefix+':'+scope.accountId
 const redis=new Redis({...await developmentRedisConnection(),lazyConnect:true,maxRetriesPerRequest:1})
 redis.on('error',()=>{})
 try{
  await redis.connect()
  const leases=new RedisAccountExecutionLeaseStore(redis,prefix)
  let loads=0
  const make=loseAck=>createPositionProtectionPreparationReceiver({scope:createMysqlPositionProtectionReceiverScope(pool),leases,
   source:{async loadPrepared(){loads++;return {intentId:input.executionIntentId,accountId:input.accountId,command:input}}},
   commands:new BridgeCommandService(repository(null,loseAck)),now:()=>now})
  assert.equal(await leases.acquire(scope.accountId,'other-owner',15),true)
  await assert.rejects(make(false)(scope,input.executionIntentId),/position_protection_receiver_busy/)
  assert.equal(loads,0);await leases.release(scope.accountId,'other-owner')
  await assert.rejects(make(true)(scope,input.executionIntentId),/bridge_command_commit_unknown/)
  assert.equal(loads,1);assert.equal(await redis.exists(key),0)
  const service=new BridgeCommandService(repository()),saved=await service.findByIntent(input.executionIntentId,1)
  assert.equal(saved.status,'queued');assert.equal(saved.dispatchedAt,null)
  await make(false)(scope,input.executionIntentId)
  assert.equal(loads,1);assert.equal(await redis.exists(key),0)
  assert.deepEqual(await service.findByIntent(input.executionIntentId,1),saved)
  const db=await pool.getConnection()
  try{
   const [rows]=await db.execute("SELECT event_type,payload_json,status FROM outbox_events WHERE aggregate_id=?",[saved.id])
   assert.equal(rows.length,1);assert.equal(rows[0].event_type,'bridge.command.queued');assert.equal(rows[0].status,'pending')
   const payload=typeof rows[0].payload_json==='string'?JSON.parse(rows[0].payload_json):rows[0].payload_json
   assert.deepEqual(payload,{command_id:saved.id,trading_account_id:scope.accountId})
  }finally{db.release()}
  return {passed:true,checks:['real-account-lease-busy-prevents-command-preparation','prepare-receiver-command-binding-outbox-survive-commit-ack-loss',
   'prepared-replay-loads-durable-command-without-recreating','one-pending-command-id-outbox-and-no-dispatched-command'],
   source:'injected-command-candidate',commandPersistence:'actual-MysqlBridgeCommandRepository',terminalTransport:'not-provided',leaseRemoved:true}
 }finally{await redis.del(key);await redis.quit()}
}

export async function verifyProtectionReceiverDispatch(pool,repository,command,scope,now) {
 const prefix='protection-lease-reference-'+randomUUID().replaceAll('-',''),key=prefix+':'+scope.accountId
 const redis=new Redis({...await developmentRedisConnection(),lazyConnect:true,maxRetriesPerRequest:1})
 redis.on('error',()=>{})
 try {
  await redis.connect()
  const leases=new RedisAccountExecutionLeaseStore(redis,prefix)
  let sends=0
  const transport={async currentRoute(){return command.route},async send(){sends++}}
  const make=loseAck=>createPositionProtectionReceivers({scope:createMysqlPositionProtectionReceiverScope(pool),
   source:{async loadPrepared(){throw Error('existing_command_must_not_be_recreated')}},leases,
   commands:new BridgeCommandService(repository(null,loseAck,true)),transport,now:()=>now})
  assert.equal(await leases.acquire(scope.accountId,'other-owner',15),true)
  await assert.rejects(()=>make(false).prepared(scope,command.executionIntentId),/position_protection_receiver_busy/)
  assert.equal(sends,0)
  await leases.release(scope.accountId,'other-owner')
  await assert.rejects(()=>make(true).prepared(scope,command.executionIntentId),/bridge_command_commit_unknown/)
  assert.equal(sends,0);assert.equal(await redis.exists(key),0)
  await make(false).prepared(scope,command.executionIntentId)
  assert.equal(sends,0);assert.equal(await redis.exists(key),0)
  return {passed:true,checks:['real-Redis-busy-lease-prevents-dispatch','real-receiver-SQL-dispatch-ack-loss-never-writes-socket','durable-dispatched-recovery-never-recreates-or-resends','owned-lease-released-after-errors-and-recovery'],leaseRemoved:true,transport:'local-injected',existingDatabaseWrites:0}
 }finally{await redis.del(key);await redis.quit()}
}
