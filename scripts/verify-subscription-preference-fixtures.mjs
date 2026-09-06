import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import { readSubscriptionExecutionPreferences } from '../server/dist-v4/modules/strategies/infrastructure/mysql-subscription-execution-preferences.js'
import { executionPreferencesMatch } from '../server/dist-v4/modules/strategies/domain/subscription-take-profit.js'

const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const root = new URL('../', import.meta.url)
const path = new URL('docs/migration/subscription-preference-fixtures-20260907.json', root)
let connection
try {
  const mode = process.argv[2]
  if (process.argv.length !== 3 || !['--write', '--verify'].includes(mode)) throw new Error('arguments')
  const env = parse(await readFile(new URL('server/.env', root)))
  if (env.MYSQL_DATABASE !== 'dev_vue') throw new Error('database')
  connection = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, timezone: 'Z' })
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,VERSION() version')
  if (identity.db !== 'dev_vue' || identity.uuid !== 'ac423207-6ef3-11f1-b302-000c29fda104') throw new Error('identity')
  await connection.query('START TRANSACTION READ ONLY')
  const baseline = { subscription: '9', user: 7, account: '5', version: 1, mode: 'standard', revision: '9007199254740993' }
  const frozen = { contractVersion: 1, takeProfitMode: 'standard', revision: '9007199254740993' }
  const cases = [
    { name: 'matching', changes: {}, present: true, matches: true },
    { name: 'wrong_user', changes: { user: 8 }, present: false, matches: false },
    { name: 'wrong_account', changes: { account: '6' }, present: false, matches: false },
    { name: 'wrong_subscription', changes: { subscription: '10' }, present: false, matches: false },
    { name: 'changed_mode', changes: { mode: 'trend' }, present: true, matches: false },
    { name: 'changed_revision', changes: { revision: '9007199254740994' }, present: true, matches: false },
    { name: 'invalid_version', changes: { version: 2 }, error: 'subscription_execution_preferences_invalid' },
    { name: 'invalid_mode', changes: { mode: 'unknown' }, error: 'subscription_execution_preferences_invalid' },
  ]
  const input = JSON.parse(await readFile(new URL('docs/migration/subscription-window-sql-input-v5-20260907.json', root), 'utf8'))
  const query = input.queries.find(item => item.name === 'subscription_preferences')
  const results = []
  for (const fixture of cases) {
    const value = { ...baseline, ...fixture.changes }
    const db = { execute(sql, parameters) {
      if (sql !== query.sql) throw new Error('sql_changed')
      // Both physical names used by the captured query are shadowed. No real
      // business rows or temporary tables participate in these data fixtures.
      return connection.execute(`WITH subscription_execution_preferences_v4 AS
        (SELECT ? subscription_id,? contract_version,? take_profit_mode,CAST(? AS CHAR) revision),
        strategy_subscriptions AS (SELECT ? id,? user_id,? trading_account_id) ${sql}`,
      [value.subscription, value.version, value.mode, value.revision, value.subscription, value.user, value.account, ...parameters])
    } }
    let result, errorCode = null
    try { result = await readSubscriptionExecutionPreferences(db, { subscriptionId: '9', userId: 7, accountId: '5' }) }
    catch (error) { errorCode = error.code ?? 'query_failed' }
    if (fixture.error) {
      if (errorCode !== fixture.error) throw new Error('fixture_error_mismatch')
    } else if (errorCode || Boolean(result) !== fixture.present || executionPreferencesMatch(frozen, result) !== fixture.matches) throw new Error('fixture_result_mismatch')
    results.push({ name: fixture.name, fixtureSha256: sha(value), errorCode, present: Boolean(result), matches: result ? executionPreferencesMatch(frozen, result) : false })
  }
  await connection.rollback()
  const report = { observedAt: new Date().toISOString(), identity, sqlSha256: query.sqlSha256, results, businessWritesPerformed: false, concurrencyVerified: false }
  if (mode === '--verify') {
    const previous = JSON.parse(await readFile(path, 'utf8'))
    const stable = ({ observedAt, ...data }) => data
    if (sha(stable(previous)) !== sha(stable(report))) throw new Error('receipt_mismatch')
  } else await writeFile(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ scenarios: results.length, passed: true, businessWritesPerformed: false }))
} catch (error) {
  await connection?.rollback().catch(() => {})
  console.error(JSON.stringify({ status: 'failed', code: error.code ?? 'preference_fixture_failed' }))
  process.exitCode = 1
} finally { await connection?.end() }
