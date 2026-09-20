import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import Fastify from 'fastify'
import { createInferenceHttp, createMysqlArchivedSignalReader } from '../server/dist-v4/modules/inference/composition.js'
import { createExecutionHttp, createMysqlArchivedExecutionReader } from '../server/dist-v4/modules/execution/composition.js'
import { createMysqlTradeHistoryHttp } from '../server/dist-v4/modules/trade-history/composition.js'
const [destination]=process.argv.slice(2)
assert.ok(process.argv.length===3 && isAbsolute(destination??''))
const env=parse(await readFile(new URL('../server/.env',import.meta.url)))
assert.equal(env.MYSQL_HOST,'192.168.1.254'); assert.equal(env.MYSQL_DATABASE,'dev_vue')
const output=await open(destination,'wx',0o600)
const report={kind:'history-archive-current-http/v1',passed:false,writes:0,authentication:'injected-user-not-browser-session',checks:[]}
let pool,app
try {
  pool=mysql.createPool({host:env.MYSQL_HOST,port:Number(env.MYSQL_PORT),user:env.MYSQL_USER,password:env.MYSQL_PASSWORD,
    database:env.MYSQL_DATABASE,connectionLimit:1,timezone:'Z',dateStrings:true,supportBigNumbers:true,bigNumberStrings:true})
  const connection=await pool.getConnection()
  try {
    await connection.query("SET SESSION time_zone='+00:00'")
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
    const [[identity]]=await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
    assert.equal(identity.db,'dev_vue');assert.equal(identity.uuid,'ac423207-6ef3-11f1-b302-000c29fda104')
    report.identity=identity
  }finally{connection.release()}
  app=Fastify({logger:false});let userId=1
  const auth={authenticate:async()=>({userId})}
  await app.register(createInferenceHttp(undefined,auth,undefined,createMysqlArchivedSignalReader(pool)))
  await app.register(createExecutionHttp(undefined,undefined,undefined,auth,createMysqlArchivedExecutionReader(pool)))
  await app.register(createMysqlTradeHistoryHttp(pool,auth,createMysqlArchivedExecutionReader(pool)))
  for(const [kind,table] of [['signals','ai_signals'],['executions','order_intents']]) {
    const base='/api/v4/history/'+kind
    const [[count]]=await pool.execute(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`,[userId])
    const ids=new Set();let cursor
    do {
      const response=await app.inject(base+'?page_size=100'+(cursor?'&cursor='+cursor:''))
      assert.equal(response.statusCode,200)
      const data=response.json().data
      assert.equal(data.identity_namespace,'retained-legacy');assert.equal(data.executable,false)
      for(const row of data.items){assert.ok(!ids.has(row.legacy_id));ids.add(row.legacy_id);assert.ok(row.created_at_utc.endsWith('Z'))}
      assert.ok(!data.next_cursor || data.items.length===100)
      assert.ok(!cursor || !data.next_cursor || BigInt(data.next_cursor)<BigInt(cursor))
      cursor=data.next_cursor
    }while(cursor)
    assert.equal(ids.size,Number(count.n));assert.ok(ids.size)
    const id=[...ids][0]
    const detail=await app.inject(base+'/'+id);assert.equal(detail.statusCode,200)
    assert.equal(detail.json().data.legacy_id,id)
    userId=2147483647
    assert.equal((await app.inject(base+'/'+id)).statusCode,404)
    assert.deepEqual((await app.inject(base)).json().data.items,[])
    userId=0;assert.equal((await app.inject(base)).statusCode,401)
    userId=1
    report.checks.push({kind,originalUser:1,records:ids.size,allPagesMatchDatabaseCount:true,detailContractPassed:true,otherUserDenied:true,systemZeroDenied:true})
  }
  const [examples]=await pool.query('SELECT CAST(i.id AS CHAR) id,i.user_id,COUNT(*) n FROM order_intents i INNER JOIN signal_outcomes o ON o.order_intent_id=i.id AND o.user_id=i.user_id AND o.trading_account_id=i.trading_account_id INNER JOIN signal_outcome_deals d ON d.outcome_id=o.id AND d.user_id=o.user_id AND d.trading_account_id=o.trading_account_id WHERE i.user_id=1 GROUP BY i.id,i.user_id ORDER BY COUNT(*) DESC,i.id DESC LIMIT 3')
  assert.ok(examples.length)
  report.dealChecks=[]
  for(const example of examples){
    userId=Number(example.user_id)
    const path='/api/v4/history/executions/'+example.id+'/deals'
    const records=[];let cursor
    do{
      const response=await app.inject(path+'?page_size=1'+(cursor?'&cursor='+cursor:''));assert.equal(response.statusCode,200)
      const data=response.json().data
      for(const row of data.items){assert.equal(typeof row.profit,'string');assert.equal(typeof row.volume,'string');records.push(row)}
      assert.ok(!cursor || !data.next_cursor || BigInt(data.next_cursor)<BigInt(cursor));cursor=data.next_cursor
    }while(cursor)
    assert.equal(records.length,Number(example.n));assert.equal(new Set(records.map(row=>row.legacy_id)).size,records.length)
    for(const record of records){
      const [[original]]=await pool.execute('SELECT CAST(profit AS CHAR) profit,CAST(volume AS CHAR) volume,CAST(commission AS CHAR) commission,CAST(swap AS CHAR) swap,CAST(fee AS CHAR) fee,deal_ticket FROM signal_outcome_deals WHERE id=?',[record.legacy_id])
      for(const key of Object.keys(original))assert.equal(record[key],original[key])
    }
    userId=2147483647;assert.equal((await app.inject(path)).statusCode,404)
    report.dealChecks.push({legacyIntentId:example.id,records:records.length,exactAmountsAndTickets:true,wrongUserDenied:true})
  }
  report.passed=true
}catch(error){report.errorCode=error?.code??error?.message??'archive_http_probe_failed';process.exitCode=1}
finally {
  if(app)await app.close()
  if(pool){const connection=await pool.getConnection();try{await connection.rollback()}finally{connection.release();await pool.end()}}
  report.observedAt=new Date().toISOString();await output.writeFile(JSON.stringify(report,null,2)+'\n');await output.close();console.log(JSON.stringify(report))
}
