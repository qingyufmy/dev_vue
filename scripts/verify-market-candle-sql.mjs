import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import { MysqlTradingRepository } from '../server/dist-v4/modules/trading/infrastructure/mysql-trading-repository.js'

const root = new URL('../', import.meta.url)
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fixture = `WITH RECURSIVE seq AS (SELECT 1 n UNION ALL SELECT n+1 FROM seq WHERE n<160),
  market_candles AS (
    SELECT '7' trading_account_id,'XAUUSD' symbol,'M1' timeframe,
      TIMESTAMPADD(MINUTE,n,CAST('2026-01-01 00:00:00' AS DATETIME)) open_time_utc,
      CAST('9007199254740993.001234' AS DECIMAL(24,6)) open_price,
      CAST('9007199254740994.001234' AS DECIMAL(24,6)) high_price,
      CAST('9007199254740992.001234' AS DECIMAL(24,6)) low_price,
      CAST('9007199254740993.001235' AS DECIMAL(24,6)) close_price,
      CAST('9007199254740993' AS UNSIGNED) tick_volume,1 closed,n revision FROM seq
    UNION ALL SELECT '8','XAUUSD','M1','2030-01-01',1,2,1,2,1,1,1
    UNION ALL SELECT '7','EURUSD','M1','2030-01-01',1,2,1,2,1,1,1
    UNION ALL SELECT '7','XAUUSD','H1','2030-01-01',1,2,1,2,1,1,1
  ) `
let connection, phase = 'setup'
try {
  const mode = process.argv[2]
  if (process.argv.length !== 3 || !['--write', '--verify'].includes(mode)) throw new Error('arguments')
  const env = parse(await readFile(new URL('server/.env', root)))
  if (env.MYSQL_DATABASE !== 'dev_vue') throw new Error('database')
  connection = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true })
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('START TRANSACTION READ ONLY')
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,VERSION() version')
  if (identity.db !== 'dev_vue' || identity.uuid !== 'ac423207-6ef3-11f1-b302-000c29fda104') throw new Error('identity')
  let forceNumeric = true, sqlHash
  const repository = new MysqlTradingRepository({ execute(sql, parameters) {
    if (!sql.startsWith('SELECT ') || sql.includes(';') || (sql.match(/FROM market_candles/g) ?? []).length !== 1) throw new Error('query_scope')
    sqlHash = sha(sql)
    const args = [...parameters]
    if (forceNumeric) args[3] = Number(args[3])
    return connection.execute(fixture + sql, args)
  } })
  phase = 'numeric_control'
  let numericControl = 'succeeded'
  try { await repository.listCandles('7', 'XAUUSD', 'M1', 30) }
  catch (error) { numericControl = error.code ?? error.name }
  if (!['succeeded', 'ER_WRONG_ARGUMENTS'].includes(numericControl)) throw new Error('numeric_control_unexpected')
  forceNumeric = false
  phase = 'actual_repository'
  const results = []
  for (const limit of [1, 10, 30, 100, 150, 1000]) {
    const rows = await repository.listCandles('7', 'XAUUSD', 'M1', limit)
    const count = Math.min(limit, 160)
    if (rows.length !== count || rows.some((row, i) => row.accountId !== '7' || row.symbol !== 'XAUUSD' || row.timeframe !== 'M1'
      || row.revision !== 161 - count + i || row.open !== '9007199254740993.001234' || row.tickVolume !== '9007199254740993')) throw new Error('candle_result_mismatch')
    results.push({ limit, count, firstRevision: rows[0].revision, lastRevision: rows.at(-1).revision, resultHash: sha(rows) })
  }
  const report = { observedAt: new Date().toISOString(), identity, sqlHash, fixtureHash: sha(fixture), numericControl, results, businessWritesPerformed: false, physicalSchemaVerified: false }
  await connection.rollback()
  const path = new URL('docs/migration/market-candle-sql-validation-20260907.json', root)
  if (mode === '--verify') {
    const stable = ({ observedAt, ...value }) => value
    if (sha(stable(JSON.parse(await readFile(path, 'utf8')))) !== sha(stable(report))) throw new Error('receipt_mismatch')
  } else await writeFile(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ numericControl, scenarios: results.length, passed: true }))
} catch (error) {
  await connection?.rollback().catch(() => {})
  console.error(JSON.stringify({ status: 'failed', phase, code: error.code ?? 'market_candle_probe_failed' }))
  process.exitCode = 1
} finally { await connection?.end() }
