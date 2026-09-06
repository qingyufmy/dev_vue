import { readFile, writeFile } from 'node:fs/promises'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import { hash } from './lib/v4-backfill-contract.mjs'
import { legacyStrategyFields, legacySubscriptionFields, reviewStrategySources } from './lib/v4-strategy-source-review.mjs'
import { convertSubscriptionSymbols } from './lib/v4-subscription-symbol-conversion.mjs'
import { planAccountIdMappings } from './lib/v4-account-id-mapping.mjs'
import { reviewSubscriptionAccountScopes } from './lib/v4-subscription-account-review.mjs'
import { convertSubscriptionSchedule } from './lib/v4-subscription-schedule-conversion.mjs'
import { reviewSubscriptionConfig } from './lib/v4-subscription-config-review.mjs'

import { convertStrategyMetadata } from './lib/v4-strategy-metadata-conversion.mjs'

import { convertStrategyMarketPlan } from './lib/v4-strategy-market-plan-conversion.mjs'

const root = new URL('../', import.meta.url)
let connection
try {
  const [mode] = process.argv.slice(2)
  if (process.argv.length !== 3 || !['--write', '--verify', '--write-symbols', '--verify-symbols', '--write-scopes', '--verify-scopes', '--write-schedules', '--verify-schedules', '--write-config', '--verify-config', '--write-metadata', '--verify-metadata', '--write-market-plan', '--verify-market-plan'].includes(mode)) throw new Error('strategy_source_arguments')
  const marketMode = mode.endsWith('-market-plan')
  const metadataMode = mode.endsWith('-metadata')
  const configMode = mode.endsWith('-config')
  const scheduleMode = mode.endsWith('-schedules')
  const scopeMode = mode.endsWith('-scopes')
  const symbolMode = mode.endsWith('-symbols') || scopeMode
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
  const [accounts] = await connection.query('SELECT CAST(id AS CHAR) id,CAST(user_id AS CHAR) userId,broker_server server,login_account login FROM trading_accounts ORDER BY id')
  const review = reviewStrategySources({ strategies, subscriptions, userIds: new Set(users.map(row => row.id)), accountIds: new Set(accounts.map(row => row.id)) })
  let scopeReview
  if (scopeMode) {
    const [terminals] = await connection.query('SELECT terminal_instance_id id,CAST(user_id AS CHAR) userId,platform,broker_server server,login_account login FROM bridge_v3_terminal_sessions ORDER BY terminal_instance_id')
    const [bindings] = await connection.query('SELECT broker_server_key server,login_account login,CAST(current_user_id AS CHAR) currentUserId,CAST(current_trading_account_id AS CHAR) currentAccountId,account_currency currency FROM mt5_account_bindings ORDER BY broker_server_key,login_account')
    const input = Object.fromEntries(Object.entries({ accounts, terminals, bindings }).map(([key, rows]) => [key, rows.map(row => ({ ...row, sourceHash: hash({ ...row }) }))]))
    const accountPlan = planAccountIdMappings('dev_vue', input, accounts.map(row => row.id))
    scopeReview = reviewSubscriptionAccountScopes({ subscriptions, strategies, accounts, accountPlan })
  }
  let configReview
  if (configMode) {
    const [riskProfiles] = await connection.query('SELECT CAST(id AS CHAR) id,CAST(user_id AS CHAR) user_id,status,CAST(deleted_at AS CHAR) deleted_at FROM risk_profiles ORDER BY id')
    configReview = subscriptions.map(row => ({ locatorHash: hash(row.id), sourceRowHash: hash(row),
      ...reviewSubscriptionConfig(row, strategies.find(strategy => strategy.id === row.strategy_id), { riskProfiles, strategies }) }))
  }
  await connection.rollback()
  const report = { observedAt: new Date().toISOString(), identity, ...review }
  if (symbolMode || scheduleMode || configMode || metadataMode || marketMode) {
    const previousSource = JSON.parse(await readFile(new URL('docs/migration/dev-vue-strategy-source-review-20260906.json', root), 'utf8'))
    if (previousSource.sourceHash !== review.sourceHash) throw new Error('strategy_source_changed')
  }
  if (symbolMode) {
    const byId = new Map(strategies.map(row => [row.id, row]))
    report.symbolConversions = subscriptions.map(row => ({ locatorHash: hash(row.id), sourceRowHash: hash(row),
      ...convertSubscriptionSymbols(row.symbols_json, byId.get(row.strategy_id)?.symbols_json) }))
    report.symbolConversionReady = report.symbolConversions.every(row => row.status === 'converted')
  }
  if (scopeMode) report.accountScopes = scopeReview
  if (scheduleMode) {
    report.scheduleConversions = subscriptions.map(row => ({ locatorHash: hash(row.id), sourceRowHash: hash(row), ...convertSubscriptionSchedule(row) }))
    report.scheduleConversionReady = report.scheduleConversions.every(row => row.status === 'converted')
  }
  if (marketMode) report.marketPlanConversions = strategies.map(row => ({ locatorHash: hash(row.id), sourceRowHash: hash(row), ...convertStrategyMarketPlan(row.market_data_plan_json) }))
  if (metadataMode) report.metadataConversions = strategies.map(row => ({ sourceRowHash: hash(row), ...convertStrategyMetadata(row, new Set(users.map(user => user.id))) }))
  if (configMode) report.configReview = configReview
  const path = new URL(marketMode ? 'docs/migration/dev-vue-strategy-market-plan-review-20260907.json' : metadataMode ? 'docs/migration/dev-vue-strategy-metadata-review-20260907.json' : configMode ? 'docs/migration/dev-vue-subscription-config-review-20260907.json' : scheduleMode ? 'docs/migration/dev-vue-subscription-schedule-review-20260907.json' : scopeMode ? 'docs/migration/dev-vue-subscription-account-review-20260907.json' : symbolMode ? 'docs/migration/dev-vue-subscription-symbol-review-20260907.json' : 'docs/migration/dev-vue-strategy-source-review-20260906.json', root)
  if (mode.startsWith('--verify')) {
    const old = JSON.parse(await readFile(path, 'utf8'))
    const stable = ({ observedAt, ...value }) => value
    if (hash(stable(old)) !== hash(stable(report))) throw new Error('strategy_source_changed')
  } else await writeFile(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ counts: report.counts, issues: report.issues, blockers: report.blockers,
    ...(marketMode ? { marketPlanConversions: report.marketPlanConversions } : {}),
    ...(metadataMode ? { metadataConversions: report.metadataConversions } : {}),
    ...(configMode ? { configReview: report.configReview } : {}),
    ...(scheduleMode ? { scheduleConversionReady: report.scheduleConversionReady, scheduleConversions: report.scheduleConversions } : scopeMode ? { accountScopes: report.accountScopes } : symbolMode ? { symbolConversionReady: report.symbolConversionReady, symbolConversions: report.symbolConversions } : {}), businessWritesPerformed: false }))
} catch (error) {
  console.error(JSON.stringify({ code: /^strategy_source_/.test(error.message) ? error.message : 'strategy_source_review_failed' }))
  process.exitCode = 1
} finally { if (connection) await connection.end().catch(() => {}) }
