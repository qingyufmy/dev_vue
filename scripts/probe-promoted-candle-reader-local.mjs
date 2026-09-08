import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { createMysqlPool } from '../server/dist-v4/bootstrap/runtime-resources.js'
import { hash } from './lib/v4-backfill-contract.mjs'
import { createTradingReader } from '../server/dist-v4/modules/trading/composition.js'

const root = new URL('../', import.meta.url), target = 'dev_vue_m1_source_20260907_02'
const sha = value => createHash('sha256').update(value).digest('hex')
const [mode, destination] = process.argv.slice(2)
assert.ok(mode === '--read-only-restored' && process.argv.length === 4 && isAbsolute(destination ?? ''))
const previous = JSON.parse(await readFile(new URL('docs/architecture/account-readiness-restored-probe-20260908.json', root)))
const sourceHash = sha(await readFile(new URL(previous.source, root)))
const runtimeHash = sha(await readFile(new URL('server/dist-v4/modules/trading/infrastructure/mysql-trading-repository.js', root)))
assert.equal(sourceHash, previous.sourceHash); assert.equal(runtimeHash, previous.runtimeHash)
const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
const credential = JSON.parse(Buffer.concat(chunks).toString('utf8'))
assert.ok(credential.host === '127.0.0.1' && credential.user === 'root' && Number.isInteger(credential.port) && credential.port > 1024 && credential.port < 65536)
const pool = createMysqlPool({ host: credential.host, port: credential.port, user: credential.user, password: credential.password, database: target, poolSize: 1 })
const db = await pool.getConnection()
try {
  await db.query("SET SESSION time_zone='+00:00'")
  const [[identity]] = await db.query('SELECT DATABASE() databaseName,@@server_uuid serverUuid')
  assert.equal(identity.databaseName, target); assert.equal(identity.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  const reader = createTradingReader(db)
  const [groups] = await db.query('SELECT CAST(trading_account_id AS CHAR) accountId,symbol,timeframe,COUNT(*) n FROM market_candles GROUP BY trading_account_id,symbol,timeframe ORDER BY trading_account_id,symbol,timeframe LIMIT 101')
  assert.ok(groups.length > 0 && groups.length <= 100)
  const symbols = new Map(), results = []
  for (const group of groups) {
    if (!symbols.has(group.accountId)) symbols.set(group.accountId, await reader.listSymbols(group.accountId))
    assert.ok(symbols.get(group.accountId).includes(group.symbol))
    const rows = await reader.listCandles(group.accountId, group.symbol, group.timeframe, 20)
    const [expectedRows] = await db.execute('SELECT CAST(trading_account_id AS CHAR) accountId,symbol,timeframe,CAST(open_time_utc AS CHAR) open_time_utc,open_price,high_price,low_price,close_price,tick_volume,closed,revision FROM market_candles WHERE trading_account_id=? AND symbol=? AND timeframe=? ORDER BY open_time_utc DESC LIMIT 20', [group.accountId, group.symbol, group.timeframe])
    const expected = expectedRows.reverse().map(row => ({ accountId: row.accountId, symbol: row.symbol, timeframe: row.timeframe,
      openTime: new Date(row.open_time_utc.replace(' ', 'T') + 'Z').toISOString(), open: String(row.open_price), high: String(row.high_price),
      low: String(row.low_price), close: String(row.close_price), tickVolume: String(row.tick_volume), closed: Boolean(row.closed), revision: Number(row.revision) }))
    assert.equal(hash(rows), hash(expected), 'candle_reader_content_mismatch')
    assert.equal(rows.length, Math.min(20, Number(group.n)))
    assert.ok(rows.every(row => row.accountId === group.accountId && row.symbol === group.symbol && row.timeframe === group.timeframe && row.closed === true))
    assert.equal(new Set(rows.map(row => row.openTime)).size, rows.length)
    results.push({ accountId: group.accountId, symbol: group.symbol, timeframe: group.timeframe,
      availableRows: Number(group.n), returnedRows: rows.length, contentHash: hash(rows), passed: true })
  }
  await db.rollback()
  const report = { kind: 'promoted-candle-reader-probe/v1', observedAt: new Date().toISOString(), identity, sourceHash, runtimeHash, connectionFactory: 'createMysqlPool', timestampMode: 'UTC driver Date; independent SQL CHAR oracle',
    groups: results, accountCount: symbols.size, checkedRows: results.reduce((sum, row) => sum + row.returnedRows, 0),
    totalCandleRows: results.reduce((sum, row) => sum + row.availableRows, 0), databaseWrites: 0,
    scope: 'Nonempty repository symbol and candle reads compared with bounded direct SQL tails. No HTTP authorization, realtime, browser or execution readiness claim.' }
  await writeFile(destination, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ groups: results.length, accounts: report.accountCount, checkedRows: report.checkedRows, totalCandleRows: report.totalCandleRows }))
} finally { db.release(); await pool.end() }
