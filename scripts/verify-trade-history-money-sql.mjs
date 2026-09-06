import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import mysql from 'mysql2/promise'
import dotenv from 'dotenv'
import { MysqlTradeHistoryRepository } from '../server/dist-v4/modules/trade-history/infrastructure/mysql-trade-history-repository.js'

// SELECT-only synthetic CTEs shadow table names; no DDL, DML or business rows.
// Build the server first so this exercises the actual repository SQL.
const env = dotenv.parse(await readFile(new URL('../server/.env', import.meta.url)))
if (env.MYSQL_DATABASE !== 'dev_vue') throw new Error('expected_development_database')
const connection = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306),
  user: env.MYSQL_USER, password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, timezone: 'Z', dateStrings: true })
const cases = [
  { name: 'same_currency', units: ['USD', 'USD'], status: 'comparable' },
  { name: 'mixed_across_days', units: ['USD', 'EUR'], status: 'mixed' },
  { name: 'partial_unknown', units: ['USD', null], status: 'unknown' },
  { name: 'all_unknown', units: [null, null], status: 'unknown' },
  { name: 'empty', units: [], status: 'empty' },
]
const results = []
try {
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('START TRANSACTION READ ONLY')
  const [[identity]] = await connection.query('SELECT VERSION() version,@@server_uuid server_uuid,DATABASE() database_name')
  assert.equal(identity.server_uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  for (const test of cases) {
    const params = []
    const rows = (test.units.length ? test.units : [null]).map((unit, index) => {
      params.push(unit, unit === null ? 'unknown' : 'explicit_record')
      return `SELECT '${index + 1}' id,7 user_id,'42' trading_account_id,'interval-1' ownership_interval_id,'complete' evidence_status,
        'closed' status,CAST('2020-01-01 00:00:00' AS DATETIME(3)) opened_at_utc,
        CAST('2020-01-0${index + 2} 00:00:00' AS DATETIME(3)) closed_at_utc,CAST('2020-01-0${index + 2}' AS DATE) close_business_date,
        CAST(? AS CHAR CHARACTER SET ascii) COLLATE ascii_bin account_currency,? currency_evidence,
        CAST('${index === 0 ? '0.1' : '-0.2'}' AS DECIMAL(24,8)) net_profit,
        CAST('${index === 0 ? '0.1' : '-0.2'}' AS DECIMAL(24,8)) gross_profit,0 commission,0 swap_amount,0 fee_amount
        ${test.units.length ? '' : 'WHERE FALSE'}`
    })
    const fixtures = `users AS (SELECT 7 id,'active' deletion_status,NULL deleted_at),
      trading_account_ownership_intervals AS (SELECT 'interval-1' id,7 user_id,'42' trading_account_id,'owner' role,
        CAST('2019-01-01' AS DATETIME(3)) started_at_utc,CAST(NULL AS DATETIME(3)) ended_at_utc),
      account_trade_records_v4 AS (${rows.join(' UNION ALL ')})`
    let executed = 0
    const repository = new MysqlTradeHistoryRepository({ async execute(sql, bindings) {
      if (!sql.includes('profit_factor') && !sql.startsWith('WITH filtered')) return [[], []]
      executed++
      const query = sql.startsWith('WITH ') ? `WITH ${fixtures},${sql.slice(5)}` : `WITH ${fixtures} ${sql}`
      return connection.execute(query, [...params, ...bindings])
    } })
    const page = await repository.list(7, { accountId: '42', capturedEnd: '2020-12-31T00:00:00.000Z', limit: 1, cursor: null })
    assert.equal(executed, 2)
    assert.equal(page.summary.moneyStatus, test.status)
    assert.equal(page.summary.tradeCount, test.units.length)
    if (test.status === 'comparable') {
      assert.equal(page.summary.accountCurrency, 'USD')
      assert.equal(page.summary.netProfit, '-0.10000000')
      assert.equal(page.summary.profitFactor, '0.50000000')
      assert.deepEqual(page.daily.map(row => row.cumulativeNetProfit), ['0.10000000', '-0.10000000'])
    } else {
      for (const field of ['accountCurrency', 'grossProfit', 'commission', 'swap', 'fee', 'netProfit', 'profitFactor']) assert.equal(page.summary[field], null)
      assert.ok(page.daily.every(row => row.netProfit === null && row.cumulativeNetProfit === null))
    }
    results.push({ name: test.name, passed: true, summary: page.summary, daily: page.daily })
  }
  const repositorySha256 = createHash('sha256').update(await readFile(new URL('../server/dist-v4/modules/trade-history/infrastructure/mysql-trade-history-repository.js', import.meta.url))).digest('hex')
  const receipt = { verifiedAt: new Date().toISOString(), scope: 'read_only_synthetic_cte_repository_aggregates', identity, repositorySha256, cases: results }
  await writeFile(new URL('../docs/migration/trade-history-money-sql-20260906.json', import.meta.url), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ scope: receipt.scope, cases: results.length, passed: true }))
} finally {
  await connection.query('ROLLBACK').catch(() => {})
  await connection.end()
}
