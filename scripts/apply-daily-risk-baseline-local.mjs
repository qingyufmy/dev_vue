import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse } from 'dotenv'
import mysql from 'mysql2/promise'
import { sha256, splitSqlStatements } from './lib/v4-migration-plan.mjs'
import { mysqlColumnStore, verifyInplaceJournal, withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
const statements = splitSqlStatements(await readFile(new URL('../server/db/migrations/20260915_032_account_daily_risk_baselines.sql', import.meta.url), 'utf8'))
assert.equal(statements.length, 1)
const step = { id: 'inplace_085_01_account_daily_risk_baselines', checksum: sha256(statements[0]) }
const e = parse(await readFile(new URL('../server/.env', import.meta.url)))
assert.equal(e.MYSQL_HOST, '192.168.1.254'); assert.equal(e.MYSQL_DATABASE, 'dev_vue')
const db = await mysql.createConnection({ host: e.MYSQL_HOST, port: Number(e.MYSQL_PORT), user: e.MYSQL_USER, password: e.MYSQL_PASSWORD, database: e.MYSQL_DATABASE })
try {
  await withInplaceUpgradeLock(db, e.MYSQL_DATABASE, async () => {
    assert.ok(await verifyInplaceJournal(db))
    const store = mysqlColumnStore(db, true), history = (await store.history()).find(row => row.id === step.id)
    if (history) assert.equal(history.checksum, step.checksum)
    const [tables] = await db.query("SELECT ENGINE engine,TABLE_COLLATION collation FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='account_daily_risk_baselines'")
    if (!tables.length) {
      assert.notEqual(history?.status, 'completed')
      if (!history) await store.begin(step)
      await store.execute(statements[0])
    }
    const [columns] = await db.query("SELECT COLUMN_NAME name,COLUMN_TYPE type,IS_NULLABLE nullable,COLUMN_DEFAULT def,COLLATION_NAME collation,EXTRA extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='account_daily_risk_baselines' ORDER BY ORDINAL_POSITION")
    assert.deepEqual(columns.map(c => [c.name,c.type,c.nullable,c.def,c.collation,c.extra]), [
      ['trading_account_id','bigint unsigned'],['ownership_interval_id','varchar(64)','ascii_bin'],['business_date','date'],
      ['day_start_equity','decimal(24,8)'],['equity_high_water','decimal(24,8)'],['net_capital_flow','decimal(24,8)'],
      ['daily_loss_percent','decimal(12,6)'],['drawdown_percent','decimal(12,6)'],['source_hash','char(64)','ascii_bin'],
      ['observed_at_utc','datetime(3)'],['revision','bigint unsigned'],
    ].map(([name,type,collation]) => [name,type,'NO',null,collation ?? null,'']))
    const [indexes] = await db.query("SELECT INDEX_NAME name,COLUMN_NAME col,NON_UNIQUE non_unique FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='account_daily_risk_baselines' ORDER BY INDEX_NAME,SEQ_IN_INDEX")
    assert.deepEqual(indexes.map(i => [i.name,i.col,i.non_unique]), ['trading_account_id','ownership_interval_id','business_date'].map(col => ['PRIMARY',col,0]))
    if (tables.length) { assert.equal(tables[0].engine,'InnoDB'); assert.equal(tables[0].collation,'utf8mb4_unicode_ci'); if (!history) await store.begin(step) }
    if (history?.status !== 'completed') await store.complete(step)
    console.log(JSON.stringify({ database: e.MYSQL_DATABASE, ...step, status: 'completed', replay: history?.status === 'completed' }))
  })
} finally { await db.end() }
