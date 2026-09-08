import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import { createMysqlPool } from '../server/dist-v4/bootstrap/runtime-resources.js'
import { MysqlTradingRepository } from '../server/dist-v4/modules/trading/infrastructure/mysql-trading-repository.js'

const destination = process.argv[2]
assert.ok(process.argv.length === 3 && isAbsolute(destination))
const output = await open(destination, 'wx', 0o600)
let pool, connection, phase = 'connect'
try {
  const env = parse(await readFile(new URL('../server/.env', import.meta.url)))
  assert.equal(env.MYSQL_DATABASE, 'dev_vue'); assert.equal(env.MYSQL_HOST, '192.168.31.254')
  pool = createMysqlPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, poolSize: 1 })
  connection = await pool.getConnection()
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid serverUuid,@@session.time_zone timezone')
  assert.equal(identity.db, 'dev_vue'); assert.equal(identity.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104'); assert.equal(identity.timezone, '+00:00')
  phase = 'clone-temporary-tables'
  // LIKE retains current columns/indexes, but MySQL does not copy FKs. Every written table is shadowed first.
  for (const table of ['trading_projection_revisions', 'account_runtime_snapshots', 'market_quotes', 'market_candles']) {
    await connection.query(`CREATE TEMPORARY TABLE \`probe_${table}\` LIKE \`${table}\``)
    await connection.query(`CREATE TEMPORARY TABLE \`${table}\` LIKE \`probe_${table}\``)
  }
  const transactionConnection = {
    execute: connection.execute.bind(connection), beginTransaction: connection.beginTransaction.bind(connection),
    commit: connection.commit.bind(connection), rollback: connection.rollback.bind(connection), release() {},
  }
  const repository = new MysqlTradingRepository({ getConnection: async () => transactionConnection })
  const stamp = '2026-09-09T00:01:02.345Z'
  const entries = [
    { resource: 'account.metrics', resourceId: 'current', table: 'account_runtime_snapshots', column: 'observed_at_utc',
      data: { id: '1', balance: '100', equity: '100', margin: '0', freeMargin: '100', floatingProfit: '0', leverage: 100,
        timezoneOffsetMinutes: 180, clockStatus: 'calibrated', tradePermission: false, observedAt: stamp, revision: 1 } },
    { resource: 'market.quote', resourceId: 'XAUUSD', table: 'market_quotes', column: 'observed_at_utc',
      data: { accountId: '1', symbol: 'XAUUSD', bid: '2000', ask: '2001', last: null, spread: '1', tradeMode: 'full', observedAt: stamp, revision: 1 } },
    { resource: 'market.candle', resourceId: 'XAUUSD:M1', table: 'market_candles', column: 'open_time_utc',
      data: { accountId: '1', symbol: 'XAUUSD', timeframe: 'M1', openTime: stamp, open: '2000', high: '2002', low: '1999', close: '2001', tickVolume: '12', closed: true, revision: 1 } },
  ]
  const checks = []
  for (const item of entries) {
    phase = item.resource
    const projection = { accountId: '1', resource: item.resource, resourceId: item.resourceId, revision: 1, data: item.data }
    assert.equal(await repository.applyProjection(projection), true)
    const [[row]] = await connection.query(`SELECT \`${item.column}\` stamp FROM \`${item.table}\``)
    assert.equal(row.stamp.toISOString(), stamp)
    assert.equal(await repository.applyProjection(projection), false)
    checks.push({ resource: item.resource, utcReadback: stamp, duplicateApplied: false })
  }
  phase = 'invalid-time-rollback'
  await assert.rejects(repository.applyProjection({ accountId: '1', resource: 'market.quote', resourceId: 'XAUUSD', revision: 2,
    data: { ...entries[1].data, observedAt: 'invalid', revision: 2 } }), error => error.code === 'trading_context_invalid')
  const [[revision]] = await connection.query("SELECT revision FROM trading_projection_revisions WHERE resource_kind='market.quote'")
  assert.equal(Number(revision.revision), 1)
  await output.writeFile(JSON.stringify({ kind: 'projection-times-mysql/v1', observedAt: new Date().toISOString(), identity, checks,
    invalidTimeRolledBack: true, permanentBusinessWrites: 0,
    scope: 'Compiled applyProjection against connection-private LIKE copies of four current tables. Verifies column/index compatibility and UTC milliseconds, not FKs, trusted route/provenance/ticket writes, concurrency or terminal integration.' }, null, 2) + '\n')
  console.log(JSON.stringify({ projections: checks.length, invalidTimeRolledBack: true, permanentBusinessWrites: 0 }))
} catch (error) {
  await output.writeFile(JSON.stringify({ failed: true, phase, code: typeof error?.code === 'string' ? error.code : 'verification_failed' }) + '\n')
  console.error('projection_times_mysql_failed'); process.exitCode = 1
} finally {
  if (connection) { await connection.rollback().catch(() => {}); connection.destroy() }
  if (pool) await pool.end()
  await output.sync(); await output.close()
}
