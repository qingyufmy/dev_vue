import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { parse } from 'dotenv'
import mysql from 'mysql2/promise'
import { sha256, splitSqlStatements } from './lib/v4-migration-plan.mjs'
import { mysqlColumnStore, verifyInplaceJournal, withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'

const source = new URL('../server/db/migrations/inplace/087_strategy_combination_receipt_actions.sql', import.meta.url)
const sql = splitSqlStatements(await readFile(source, 'utf8'))
assert.equal(sql.length, 1)
const step = { id: 'inplace_087_01_strategy_combination_receipt_actions', checksum: sha256(sql[0]) }
const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
assert.equal(env.MYSQL_HOST, '192.168.1.254'); assert.equal(env.MYSQL_DATABASE, 'dev_vue')
const db = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT), user: env.MYSQL_USER,
  password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE })
const previous = ['create_strategy','update_metadata','create_version','publish_version','retire_strategy',
  'create_subscription','update_subscription','set_account_trader']
const expected = [...previous, 'create_strategy_combination', 'create_strategy_combination_version']
try {
  await withInplaceUpgradeLock(db, 'dev_vue', async () => {
    assert.ok(await verifyInplaceJournal(db))
    const store = mysqlColumnStore(db, true)
    const history = (await store.history()).find(row => row.id === step.id)
    if (history) assert.equal(history.checksum, step.checksum)
    const readActions = async () => {
      const [rows] = await db.query("SELECT CHECK_CLAUSE clause FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_NAME='chk_strategy_receipt_action'")
      assert.equal(rows.length, 1)
      return rows[0].clause.match(/(?:create_strategy_combination_version|create_strategy_combination|set_account_trader|create_strategy|update_metadata|create_version|publish_version|retire_strategy|create_subscription|update_subscription)/g)
    }
    const actions = await readActions()
    if (JSON.stringify(actions) === JSON.stringify(previous)) {
      assert.notEqual(history?.status, 'completed')
      if (!history) await store.begin(step)
      await store.execute(sql[0])
    } else {
      assert.deepEqual(actions, expected)
      if (!history) await store.begin(step)
    }
    assert.deepEqual(await readActions(), expected)
    if (history?.status !== 'completed') await store.complete(step)
    console.log(JSON.stringify({ database: 'dev_vue', ...step, status: 'completed', replay: history?.status === 'completed' }))
  })
} finally { await db.end() }
