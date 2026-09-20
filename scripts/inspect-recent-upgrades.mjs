#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { parse } from 'dotenv'
import mysql from 'mysql2/promise'
import { loadRecentSources, inspectRecentUpgrades } from './lib/recent-upgrade-inspection.mjs'
let db
try {
  const args = process.argv.slice(2)
  if (args.length !== 1 || !args[0].startsWith('--env-file=') || !args[0].slice(11)) throw new Error('upgrade_inspection_env_file_required')
  const env = parse(await readFile(args[0].slice(11)))
  if (!env.MYSQL_HOST || !env.MYSQL_DATABASE || !env.MYSQL_USER) throw new Error('upgrade_inspection_target_required')
  const sources = await loadRecentSources(new URL('../',import.meta.url))
  db = await mysql.createConnection({host:env.MYSQL_HOST,port:Number(env.MYSQL_PORT||3306),user:env.MYSQL_USER,password:env.MYSQL_PASSWORD,database:env.MYSQL_DATABASE,multipleStatements:false,connectTimeout:10000})
  const report = await inspectRecentUpgrades(db,sources)
  console.log(JSON.stringify(report,null,2))
  if (report.journal !== 'available' || report.steps.some(step => step.status !== 'completed')) process.exitCode = 2
} catch {
  console.error(JSON.stringify({status:'inspection_failed',writes:false,message:'检查失败，请核对连接参数、迁移文件和升级台账结构。'}))
  process.exitCode = 1
} finally { await db?.end() }
