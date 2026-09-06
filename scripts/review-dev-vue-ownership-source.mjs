import { readFile, writeFile } from 'node:fs/promises'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import { hash } from './lib/v4-backfill-contract.mjs'
import { proposeAccountMappings } from './lib/v4-account-mapping-candidates.mjs'
import { inspectWallClock } from './lib/v4-identity-time.mjs'

const root = new URL('../', import.meta.url)
let connection
try {
  if (process.argv.length !== 3 || process.argv[2] !== '--read-only') throw new Error('ownership_review_arguments')
  const env = parse(await readFile(new URL('server/.env', root)))
  if (env.MYSQL_DATABASE !== 'dev_vue') throw new Error('ownership_review_database')
  connection = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, dateStrings: true, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true })
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  if (identity.db !== 'dev_vue') throw new Error('ownership_review_database')
  const [accounts] = await connection.query('SELECT CAST(id AS CHAR) id,CAST(user_id AS CHAR) userId,broker_server server,login_account login FROM trading_accounts ORDER BY id')
  const [terminals] = await connection.query('SELECT terminal_instance_id id,CAST(user_id AS CHAR) userId,platform,broker_server server,login_account login FROM bridge_v3_terminal_sessions ORDER BY terminal_instance_id')
  const [bindings] = await connection.query('SELECT broker_server_key server,login_account login,CAST(current_user_id AS CHAR) currentUserId,CAST(current_trading_account_id AS CHAR) currentAccountId,account_currency currency FROM mt5_account_bindings ORDER BY broker_server_key,login_account')
  const [intervals] = await connection.query('SELECT CAST(id AS CHAR) id,broker_server_key,login_account,CAST(user_id AS CHAR) user_id,CAST(trading_account_id AS CHAR) trading_account_id,started_at,ended_at,end_reason,created_at,updated_at FROM mt5_account_ownership_history ORDER BY id')
  const [users] = await connection.query('SELECT CAST(id AS CHAR) id FROM users ORDER BY id')
  const mapping = proposeAccountMappings('dev_vue', Object.fromEntries(Object.entries({ accounts, terminals, bindings }).map(([key, rows]) => [key, rows.map(row => ({ ...row, sourceHash: hash(row) }))])))
  const groups = new Map(), issues = [], userIds = new Set(users.map(user => user.id)), accountIds = new Set(accounts.map(account => account.id))
  let zeroLength = 0
  for (const row of intervals) {
    const locatorHash = hash(row.id)
    if (!userIds.has(row.user_id)) issues.push({ code: 'missing_user', locatorHash })
    if (!accountIds.has(row.trading_account_id)) issues.push({ code: 'missing_account', locatorHash })
    const start = inspectWallClock(row.started_at).canonicalWallClock, end = inspectWallClock(row.ended_at).canonicalWallClock
    if (!start || (end !== null && end < start)) issues.push({ code: 'reversed_or_missing_time', locatorHash })
    if (start === end) zeroLength++
    const key = hash([row.broker_server_key, row.login_account]), group = groups.get(key) ?? []
    group.push({ start, end, locatorHash }); groups.set(key, group)
  }
  for (const group of groups.values()) {
    let previous = null
    for (const item of group.sort((a, b) => String(a.start).localeCompare(String(b.start)))) {
      if (item.start === item.end) continue
      if (previous && (previous.end === null || previous.end > item.start)) issues.push({ code: 'raw_clock_overlap', locatorHash: item.locatorHash })
      previous = item
    }
  }
  const report = { version: 1, observedAtUtc: new Date().toISOString(), identity,
    counts: { accounts: accounts.length, terminals: terminals.length, bindings: bindings.length, intervals: intervals.length,
      openIntervals: intervals.filter(row => row.ended_at === null).length, zeroLength, candidateEntities: mapping.groups.length },
    sourceHash: hash({ accounts, terminals, bindings, intervals, users }),
    candidates: mapping.candidates.map(row => ({ sourceLocatorHash: hash(row.sourceAccountId), candidateKey: row.candidateKey, issues: row.issues })),
    issues, scope: 'current_identity_candidates_and_raw_wall_clock_order_only',
    timeBasisConfirmed: false, targetIdsAssigned: false, businessWritesPerformed: false, readyForBackfill: false }
  await connection.rollback()
  await writeFile(new URL('docs/migration/dev-vue-ownership-source-review-20260906.json', root), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ counts: report.counts, relationIssues: issues.length, candidateIssues: mapping.candidates.flatMap(row => row.issues).length, timeBasisConfirmed: false }))
} catch (error) {
  console.error(JSON.stringify({ code: /^(ownership|account|identity)_/.test(error.message) ? error.message : 'ownership_review_failed' }))
  process.exitCode = 1
} finally { if (connection) await connection.end().catch(() => {}) }
