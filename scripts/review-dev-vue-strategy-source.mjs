import { readFile, writeFile } from 'node:fs/promises'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import { hash } from './lib/v4-backfill-contract.mjs'
import { legacyStrategyFields, legacySubscriptionFields, reviewStrategySources } from './lib/v4-strategy-source-review.mjs'
import { convertSubscriptionSymbols } from './lib/v4-subscription-symbol-conversion.mjs'

const root = new URL('../', import.meta.url)
let connection
try {
  const [mode] = process.argv.slice(2)
  if (process.argv.length !== 3 || !['--write', '--verify', '--write-symbols', '--verify-symbols'].includes(mode)) throw new Error('strategy_source_arguments')
  const symbolMode = mode.endsWith('-symbols')
  const env = parse(await readFile(new URL('server/.env', root)))
  if (env.MYSQL_DATABASE !== 'dev_vue') throw new Error('strategy_source_database')
  connection = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, timezone: 'Z', dateStrings: true })
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  if (identity.db !== 'dev_vue' || identity.uuid !== 'ac423207-6ef3-11f1-b302-000c29fda104') throw new Error('strategy_source_identity')
  const read = async (table, fields) => {
    const [columns] = await connection.execute('SELECT COLUMN_NAME name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [table])
    if (JSON.stringify(columns.map(row => row.name)) !== JSON.stringify(fields)) throw new Error('strategy_source_schema_changed')
    const [rows] = await connection.query(`SELECT ${fields.map(field => `CAST(\`${field}\` AS CHAR) \`${field}\``).join(',')} FROM \`${table}\` ORDER BY id`)
    return rows.map(row => ({ ...row }))
  }
  const strategies = await read('auto_prompt_types', legacyStrategyFields), subscriptions = await read('strategy_subscriptions', legacySubscriptionFields)
  const [users] = await connection.query('SELECT CAST(id AS CHAR) id FROM users ORDER BY id')
  const [accounts] = await connection.query('SELECT CAST(id AS CHAR) id FROM trading_accounts ORDER BY id')
  const review = reviewStrategySources({ strategies, subscriptions, userIds: new Set(users.map(row => row.id)), accountIds: new Set(accounts.map(row => row.id)) })
  await connection.rollback()
  const report = { observedAt: new Date().toISOString(), identity, ...review }
  if (symbolMode) {
    const previousSource = JSON.parse(await readFile(new URL('docs/migration/dev-vue-strategy-source-review-20260906.json', root), 'utf8'))
    if (previousSource.sourceHash !== review.sourceHash) throw new Error('strategy_source_changed')
    const byId = new Map(strategies.map(row => [row.id, row]))
    report.symbolConversions = subscriptions.map(row => ({ locatorHash: hash(row.id), sourceRowHash: hash(row),
      ...convertSubscriptionSymbols(row.symbols_json, byId.get(row.strategy_id)?.symbols_json) }))
    report.symbolConversionReady = report.symbolConversions.every(row => row.status === 'converted')
  }
  const path = new URL(symbolMode ? 'docs/migration/dev-vue-subscription-symbol-review-20260907.json' : 'docs/migration/dev-vue-strategy-source-review-20260906.json', root)
  if (mode.startsWith('--verify')) {
    const old = JSON.parse(await readFile(path, 'utf8'))
    const stable = ({ observedAt, ...value }) => value
    if (hash(stable(old)) !== hash(stable(report))) throw new Error('strategy_source_changed')
  } else await writeFile(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ counts: report.counts, issues: report.issues, blockers: report.blockers,
    ...(symbolMode ? { symbolConversionReady: report.symbolConversionReady, symbolConversions: report.symbolConversions } : {}), businessWritesPerformed: false }))
} catch (error) {
  console.error(JSON.stringify({ code: /^strategy_source_/.test(error.message) ? error.message : 'strategy_source_review_failed' }))
  process.exitCode = 1
} finally { if (connection) await connection.end().catch(() => {}) }
