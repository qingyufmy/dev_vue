#!/usr/bin/env node
import { readFile, open } from 'node:fs/promises'
import { parse } from 'dotenv'
import mysql from 'mysql2/promise'
import { loadRecentSources } from './lib/recent-upgrade-inspection.mjs'
import { reconcileModelUpgradeHistory } from './lib/reconcile-model-upgrade-history.mjs'
let db, receipt
try {
  const args=process.argv.slice(2)
  const allowed=['--env-file=','--confirm-target=','--server-uuid=','--receipt=']
  if(args.length!==5||!args.includes('--apply')||!allowed.every(prefix=>args.filter(a=>a.startsWith(prefix)&&a.length>prefix.length).length===1))throw Error('reconciliation_arguments_required')
  const value=prefix=>args.find(a=>a.startsWith(prefix)).slice(prefix.length)
  const env=parse(await readFile(value('--env-file=')))
  const target=`${env.MYSQL_HOST}:${Number(env.MYSQL_PORT||3306)}/${env.MYSQL_DATABASE}`
  if(!env.MYSQL_HOST||!env.MYSQL_DATABASE||!env.MYSQL_USER||value('--confirm-target=')!==target)throw Error('reconciliation_confirmation_required')
  const sources=await loadRecentSources(new URL('../',import.meta.url))
  // Never overwrite an earlier prepared/committed receipt, including after a failed attempt.
  receipt=await open(value('--receipt='),'wx',0o600)
  db=await mysql.createConnection({host:env.MYSQL_HOST,port:Number(env.MYSQL_PORT||3306),user:env.MYSQL_USER,password:env.MYSQL_PASSWORD,database:env.MYSQL_DATABASE,multipleStatements:false,connectTimeout:10000})
  const report=await reconcileModelUpgradeHistory(db,sources,{database:env.MYSQL_DATABASE,serverUuid:value('--server-uuid=')},async(phase,data)=>{await receipt.writeFile(JSON.stringify({phase,...data})+'\n');await receipt.sync()})
  console.log(JSON.stringify(report))
} catch(error) {
  const code=error.message?.startsWith('reconciliation_')?error.message:'reconciliation_failed'
  console.error(JSON.stringify({status:'failed',code,message:'登记未完成或结果待核对，请先运行只读检查；不要直接重放迁移。'}));process.exitCode=1
}finally {await db?.end();await receipt?.close()}
