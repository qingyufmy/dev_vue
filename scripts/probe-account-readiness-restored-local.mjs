import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import mysql from 'mysql2/promise'
import { createTradingReader } from '../server/dist-v4/modules/trading/composition.js'

const [mode, destination] = process.argv.slice(2)
if (mode !== '--read-only-restored' || !isAbsolute(destination ?? '') || process.argv.length !== 4) throw Error('account_readiness_arguments')
const root = new URL('../', import.meta.url)
const hash = value => createHash('sha256').update(value).digest('hex')
const source = 'server/src/modules/trading/infrastructure/mysql-trading-repository.ts'
const queries = []
let operation
const reader = createTradingReader({
  async execute(sql, parameters) {
    if (!/^\s*SELECT\b/i.test(sql) || /;|\b(INTO\s+OUTFILE|INTO\s+DUMPFILE|SLEEP|BENCHMARK)\b/i.test(sql)) throw Error('account_readiness_non_select')
    queries.push({ operation, sql, parameters })
    return [[], []]
  },
})
const probes = [
  ['context', () => reader.getContext(1)],
  ['current-accounts', () => reader.listAccounts(1)],
  ['historical-accounts', () => reader.listAccounts(1, 'history')],
  ['account-by-id', () => reader.findAccount('1')],
  ['owned-account', () => reader.findOwnedAccount(1, '1')],
  ['terminal-profiles', () => reader.listTerminalProfiles(1)],
  ['observer-channels', () => reader.listObserverChannels(1)],
  ['account-snapshot', () => reader.getAccountSnapshot('1', 1)],
  ['symbols', () => reader.listSymbols('1')],
  ['quote', () => reader.getQuote('1', 'XAUUSD')],
  ['candles', () => reader.listCandles('1', 'XAUUSD', 'M5', 1)],
  ['positions', () => reader.listPositions('1', 1)],
  ['pending-orders', () => reader.listPendingOrders('1', 1)],
  ['revision', () => reader.latestRevision('1', 'account.metrics', 'current')],
]
const capture = []
for (const [name, run] of probes) {
  operation = name
  const start = queries.length
  try { await run(); capture.push({ operation, queryCount: queries.length - start, outcome: 'returned' }) }
  catch (error) {
    if (queries.length === start || error.message?.startsWith('account_readiness_')) throw error
    capture.push({ operation, queryCount: queries.length - start, outcome: 'empty_fixture_rejected', code: error.code ?? error.name })
  }
}
const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8'))
if (credentials.host !== '127.0.0.1' || credentials.user !== 'root' || !Number.isInteger(credentials.port) || credentials.port <= 1024 || credentials.port >= 65536) throw Error('account_readiness_credentials')
const target = 'dev_vue_m1_source_20260907_02'
const db = await mysql.createConnection({ host: credentials.host, port: credentials.port, user: credentials.user, password: credentials.password,
  database: target, dateStrings: true, jsonStrings: true, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true, connectTimeout: 5000, multipleStatements: false })
try {
  await db.query("SET SESSION time_zone='+00:00'")
  const [[identity]] = await db.query('SELECT DATABASE() databaseName,@@server_uuid serverUuid,@@version version')
  if (identity.databaseName !== target || identity.serverUuid !== 'ac423207-6ef3-11f1-b302-000c29fda104') throw Error('account_readiness_identity')
  await db.query('START TRANSACTION READ ONLY')
  const results = []
  for (const query of queries) {
    const item = { operation: query.operation, sqlHash: hash(query.sql), sql: query.sql, parameterCount: query.parameters?.length ?? 0 }
    try {
      await db.execute('EXPLAIN ' + query.sql, query.parameters)
      results.push({ ...item, status: 'explain_passed' })
    } catch (error) {
      if (![1054, 1146].includes(error.errno)) throw error
      results.push({ ...item, status: 'schema_blocked', errno: error.errno, code: error.code, detail: error.sqlMessage })
    }
  }
  const tables = [...new Set(queries.flatMap(({ sql }) => [...sql.matchAll(/\b(?:FROM|JOIN)\s+`?([a-z_][a-z0-9_]*)`?/gi)].map(match => match[1])))].sort()
  const [columns] = await db.execute(`SELECT TABLE_NAME tableName,COLUMN_NAME columnName FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${tables.map(() => '?').join(',')}) ORDER BY TABLE_NAME,ORDINAL_POSITION`, tables)
  const dependencies = tables.map(table => ({ table, present: columns.some(row => row.tableName === table),
    columns: columns.filter(row => row.tableName === table).map(row => row.columnName) }))
  await db.rollback()
  const report = {
    kind: 'account-readiness-restored-probe/v1', observedAt: new Date().toISOString(), identity,
    source, sourceHash: hash(await readFile(new URL(source, root))),
    runtimeHash: hash(await readFile(new URL('server/dist-v4/modules/trading/infrastructure/mysql-trading-repository.js', root))),
    capture, dependencies, results, passed: results.filter(item => item.status === 'explain_passed').length,
    blocked: results.filter(item => item.status === 'schema_blocked').length,
    databaseWrites: 0, businessRowsRead: 0,
    scope: 'Empty-row fixture captures reached SELECTs only; EXPLAIN does not establish data, authorization, cache, transaction or complete branch readiness. No full module readiness claim.',
  }
  await writeFile(destination, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ queries: results.length, passed: report.passed, blocked: report.blocked,
    failures: results.filter(item => item.status === 'schema_blocked').map(({ operation, code, detail }) => ({ operation, code, detail })) }, null, 2))
} finally { await db.end() }
