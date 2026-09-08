import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import { createMysqlPool } from '../server/dist-v4/bootstrap/runtime-resources.js'
import { assertTradingSchemaReady, createTradingReader } from '../server/dist-v4/modules/trading/composition.js'

// Run after build:server:v4. Uses the application account, never administrator credentials.
const destination = process.argv[2]
assert.ok(process.argv.length === 3 && isAbsolute(destination))
const output = await open(destination, 'wx', 0o600)
let pool, connection
try {
  const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
  assert.equal(env.MYSQL_DATABASE, 'dev_vue'); assert.equal(env.MYSQL_HOST, '192.168.31.254')
  pool = createMysqlPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, poolSize: 1 })
  await assertTradingSchemaReady(pool)
  connection = await pool.getConnection()
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  const [[identity]] = await connection.query('SELECT DATABASE() databaseName,@@server_uuid serverUuid,@@session.time_zone timezone')
  assert.equal(identity.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104'); assert.equal(identity.timezone, '+00:00')
  const [users] = await connection.query("SELECT id FROM users WHERE deletion_status='active' AND deleted_at IS NULL ORDER BY id LIMIT 101")
  const [accounts] = await connection.query('SELECT CAST(id AS CHAR) id FROM trading_accounts ORDER BY id LIMIT 1001')
  assert.ok(users.length > 0 && users.length <= 100 && accounts.length > 0 && accounts.length <= 1000)
  const reader = createTradingReader(connection)
  const totals = { users: users.length, accounts: accounts.length, visibleAccounts: 0, contexts: 0, profiles: 0, observerChannels: 0,
    ownedPairs: 0, rejectedPairs: 0 }
  for (const user of users) {
    const visible = await reader.listAccounts(user.id)
    const ids = new Set(visible.map(row => row.id))
    assert.equal(ids.size, visible.length)
    totals.visibleAccounts += visible.length
    totals.contexts += Number(await reader.getContext(user.id) !== null)
    totals.profiles += (await reader.listTerminalProfiles(user.id)).length
    totals.observerChannels += (await reader.listObserverChannels(user.id)).length
    for (const account of accounts) {
      const owned = await reader.findOwnedAccount(user.id, account.id)
      assert.equal(owned !== null, ids.has(account.id))
      if (owned) { assert.equal(owned.id, account.id); totals.ownedPairs++ }
      else totals.rejectedPairs++
    }
  }
  assert.ok(totals.ownedPairs > 0 && totals.rejectedPairs > 0)
  const report = { kind: 'current-trading-readiness/v1', observedAt: new Date().toISOString(), identity,
    schemaProfile: 'inplace-account-165/v1', checkedSteps: 165, checkedTables: 23, totals, databaseWrites: 0,
    scope: 'Real application MySQL reader and metadata readiness, consistent read-only transaction. No HTTP, Redis, browser, active terminal route or positive observer authorization evidence.' }
  await connection.rollback()
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.sync()
  console.log(JSON.stringify({ schemaReady: true, totals, databaseWrites: 0 }))
} catch (error) {
  const failure = { failed: true, code: error?.message === 'trading_schema_not_ready' ? error.message : 'current_trading_readiness_failed',
    databaseError: /^ER_[A-Z_]+$/.test(error?.code ?? '') ? error.code : undefined }
  await output.writeFile(JSON.stringify(failure) + '\n'); await output.sync()
  console.error(JSON.stringify(failure)); process.exitCode = 1
} finally {
  if (connection) { await connection.rollback().catch(() => {}); connection.release() }
  if (pool) await pool.end()
  await output.close()
}
