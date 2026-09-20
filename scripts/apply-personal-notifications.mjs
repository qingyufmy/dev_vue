import { readFile } from 'node:fs/promises'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import { sha256, splitSqlStatements } from './lib/v4-migration-plan.mjs'
import { mysqlColumnStore, withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
const env = parse(await readFile(new URL('../server/.env',import.meta.url)))
const targetDatabase = process.argv.find(v=>v.startsWith('--database='))?.slice(11) ?? 'dev_vue'
const targetHost = process.argv.find(v=>v.startsWith('--host='))?.slice(7) ?? '192.168.1.254'
if(process.argv[2] !== '--apply' || env.MYSQL_DATABASE !== targetDatabase || env.MYSQL_HOST !== targetHost) throw Error('notification_migration_scope')
const statements=splitSqlStatements(await readFile(new URL('../server/db/migrations/20260916_033_personal_notifications.sql',import.meta.url),'utf8'))
const db=await mysql.createConnection({host:env.MYSQL_HOST,port:Number(env.MYSQL_PORT),user:env.MYSQL_USER,password:env.MYSQL_PASSWORD,database:env.MYSQL_DATABASE})
try {
 await withInplaceUpgradeLock(db,env.MYSQL_DATABASE,async()=>{
  const store=mysqlColumnStore(db,true),history=await store.history()
  for(const [index,sql] of statements.entries()){
   const step={id:`personal_notifications_033_${index+1}`,checksum:sha256(sql)},old=history.find(r=>r.id===step.id)
   if(old && old.checksum!==step.checksum)throw Error('notification_migration_checksum')
   if(old?.status!=='completed') {
    if(!old)await store.begin(step)
    await store.execute(sql)
   }
   const table=sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/)[1]
   const expected=[...sql.matchAll(/^ (\w+) (INT|VARCHAR\(\d+\)|CHAR\(\d+\)|JSON|BIGINT UNSIGNED|DATETIME\(3\)|TEXT|TINYINT)(.*)$/gm)]
   const [columns]=await db.execute('SELECT COLUMN_NAME,COLUMN_TYPE,IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION',[env.MYSQL_DATABASE,table])
   if(columns.length!==expected.length || columns.some((c,i)=>c.COLUMN_NAME!==expected[i][1] || c.COLUMN_TYPE.toLowerCase()!==expected[i][2].toLowerCase() || c.IS_NULLABLE!==(expected[i][3].includes('NOT NULL')?'NO':'YES'))) throw Error('notification_migration_structure_mismatch')
   if(old?.status!=='completed')await store.complete(step)
  }
 })
 console.log(JSON.stringify({database:env.MYSQL_DATABASE,statements:statements.length,status:'complete'}))
}finally{await db.end()}
