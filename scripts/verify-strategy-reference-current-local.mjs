import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {readFile,open} from 'node:fs/promises'
import {isAbsolute} from 'node:path'
import mysql from 'mysql2/promise'
import {parse} from 'dotenv'
import {createStrategyReferencePortfolioReader} from '../server/dist-v4/bootstrap/strategy-reference-evidence.js'
import {assertMysqlExecutionWorkflowSchemaReady} from '../server/dist-v4/modules/execution/composition.js'

const [destination]=process.argv.slice(2)
assert.ok(process.argv.length===3&&isAbsolute(destination??''))
const env=parse(await readFile(new URL('../server/.env',import.meta.url)))
assert.equal(env.MYSQL_HOST,'192.168.1.254');assert.equal(env.MYSQL_DATABASE,'dev_vue')
const output=await open(destination,'wx',0o600),report={kind:'strategy-reference-current-negative-path/v1',passed:false,writes:0,checks:[]}
let pool
try{
 report.artifacts=[]
 for(const path of ['server/src/entrypoints/worker-trader.ts','server/dist-v4/entrypoints/worker-trader.js',
  'server/dist-v4/bootstrap/strategy-reference-evidence.js',
  'server/dist-v4/modules/inference/infrastructure/mysql-strategy-reference-source-reader.js',
  'server/dist-v4/modules/execution/infrastructure/execution-workflow-schema.js']){
  const bytes=await readFile(new URL('../'+path,import.meta.url))
  report.artifacts.push({path,sha256:createHash('sha256').update(bytes).digest('hex')})
 }
 pool=mysql.createPool({host:env.MYSQL_HOST,port:Number(env.MYSQL_PORT),user:env.MYSQL_USER,password:env.MYSQL_PASSWORD,
  database:env.MYSQL_DATABASE,connectionLimit:1,timezone:'Z',dateStrings:true,supportBigNumbers:true,bigNumberStrings:true})
 const initial=await pool.getConnection()
 try{
  await initial.query("SET SESSION time_zone='+00:00'")
  const [[row]]=await initial.query('SELECT @@server_uuid uuid, DATABASE() databaseName, @@session.time_zone timezone')
  assert.equal(row.uuid,'ac423207-6ef3-11f1-b302-000c29fda104')
  assert.equal(row.databaseName,'dev_vue');assert.equal(row.timezone,'+00:00')
  report.database={host:env.MYSQL_HOST,port:Number(env.MYSQL_PORT),...row}
 }finally{initial.release()}
 await assertMysqlExecutionWorkflowSchemaReady(pool);report.checks.push('actual-execution-schema-admitted')
 let routeCalls=0
 const reader=createStrategyReferencePortfolioReader(pool,{async current(){routeCalls++;throw Error('unexpected_route_read')}})
 const scope={analysisId:randomUUID(),userId:7,targetAccountId:'1',analysisStrategyId:'1',traderStrategyId:'2',symbol:'XAUUSD',asOf:new Date().toISOString()}
 for(let i=0;i<3;i++)await assert.rejects(reader.read({...scope,asOf:new Date().toISOString()}),{code:'strategy_reference_source_unavailable'})
 assert.equal(routeCalls,0);report.checks.push('missing-analysis-source-rejected-before-live-route-lookup')
 // A one-connection pool proves the reader returned its connection after every failure.
 const connection=await pool.getConnection()
 try{
  // MySQL rejects transaction-characteristic changes while a transaction remains active.
  await connection.query('SET TRANSACTION READ ONLY')
  await connection.query('START TRANSACTION READ ONLY');await connection.rollback()
  const [[row]]=await connection.query('SELECT @@session.time_zone timezone');assert.equal(row.timezone,'+00:00')
 }finally{connection.release()}
 report.checks.push('repeated-errors-rollback-and-release-pooled-connection')
 report.passed=true;report.positivePortfolioVerified=false
}catch(error){report.errorCode=error?.code??error?.name??'reference_probe_failed';process.exitCode=1}
finally{if(pool)await pool.end();report.observedAt=new Date().toISOString();await output.writeFile(JSON.stringify(report,null,2)+'\n');await output.close();console.log(JSON.stringify(report))}
