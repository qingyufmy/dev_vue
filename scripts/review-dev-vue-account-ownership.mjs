import { readFile, writeFile } from 'node:fs/promises'
import { parse } from 'dotenv'
import mysql from 'mysql2/promise'
import { hash } from './lib/v4-backfill-contract.mjs'
import { planAccountIdMappings } from './lib/v4-account-id-mapping.mjs'
import { accountSourceFields, inspectAccountConversion } from './lib/v4-account-conversion.mjs'
import { reviewAccountOwnership } from './lib/v4-account-ownership-consistency.mjs'
import { readInplaceAccountTargetIdentity } from './lib/mysql-inplace-account-backfill.mjs'
const root = new URL('../', import.meta.url)
let connection
try {
  const mode = process.argv[2]
  if (process.argv.length !== 3 || !['--read-only', '--verify'].includes(mode)) throw new Error('account_conversion_review_arguments')
  const env = parse(await readFile(new URL('server/.env', root)))
  if (env.MYSQL_DATABASE !== 'dev_vue') throw new Error('account_conversion_review_database')
  connection = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, dateStrings: true, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true })
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  const backup = JSON.parse(await readFile(new URL('docs/migration/dev-vue-inplace-backup-20260906.json', root)))
  if (identity.db !== 'dev_vue' || identity.uuid !== backup.serverUuid) throw new Error('account_conversion_review_database')
  const columns = accountSourceFields.map(name => ['id', 'user_id', 'is_deleted'].includes(name) ? `CAST(\`${name}\` AS CHAR) \`${name}\`` : `\`${name}\``).join(',')
  const [rawRows] = await connection.query(`SELECT ${columns} FROM trading_accounts ORDER BY id`)
  const rows = rawRows.map(row => ({ ...row }))
  const [terminals] = await connection.query('SELECT terminal_instance_id id,CAST(user_id AS CHAR) userId,platform,broker_server server,login_account login FROM bridge_v3_terminal_sessions ORDER BY terminal_instance_id')
  const [bindings] = await connection.query('SELECT broker_server_key server,login_account login,CAST(current_user_id AS CHAR) currentUserId,CAST(current_trading_account_id AS CHAR) currentAccountId,account_currency currency FROM mt5_account_bindings ORDER BY broker_server_key,login_account')
  const [users] = await connection.query('SELECT CAST(id AS CHAR) id FROM users ORDER BY id')
  const accounts = rows.map(row => ({ id: row.id, userId: row.user_id, server: row.broker_server, login: row.login_account }))
  const input = Object.fromEntries(Object.entries({ accounts, terminals, bindings }).map(([key, values]) => [key, values.map(row => ({ ...row, sourceHash: hash({ ...row }) }))]))
  const plan = planAccountIdMappings('dev_vue', input, accounts.map(row => row.id))
  const inspected = inspectAccountConversion(rows, plan, new Set(users.map(row => row.id)))
  const [rawIntervals] = await connection.query('SELECT CAST(id AS CHAR) id,broker_server_key,login_account,CAST(user_id AS CHAR) user_id,CAST(trading_account_id AS CHAR) trading_account_id,started_at,ended_at,end_reason,created_at,updated_at FROM mt5_account_ownership_history ORDER BY id')
  const ownership = reviewAccountOwnership({ accounts: rows, bindings, intervals: rawIntervals.map(row => ({ ...row })), accountMap: plan.ownershipMap, userIds: new Set(users.map(row => row.id)) })
  const targetIdentity = await readInplaceAccountTargetIdentity(connection, { sourceEvidence: true })
  const report = { kind: 'dev_vue_account_ownership_review', ownership, targetIdentity, observedAtUtc: new Date().toISOString(), identity,
    counts: { sourceRows: rows.length, entities: inspected.entities.length, settings: inspected.entries.length, fieldsPerSource: inspected.coveredFields.length },
    coveredFields: inspected.coveredFields, sourceHash: inspected.sourceHash, mappingHash: plan.mappingHash,
    perSource: inspected.entries.map(entry => ({ locatorHash: hash(entry.sourceId), sourceHash: entry.sourceHash })),
    timeBasisConfirmed: false, businessWritesPerformed: false, readyForBackfill: false }
  await connection.rollback()
  const path = new URL('docs/migration/dev-vue-account-ownership-review-v2-20260906.json', root)
  if (mode === '--verify') {
    const previous = JSON.parse(await readFile(path, 'utf8'))
    const stable = ({ observedAtUtc, ...rest }) => rest
    if (hash(stable(previous)) !== hash(stable(report))) throw new Error('account_conversion_source_changed')
  } else await writeFile(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ status: ownership.currentOwnershipConsistent ? 'verified' : 'needs_review', counts: ownership.counts, issues: ownership.issues, notes: ownership.notes, timeBasisConfirmed: false, businessWritesPerformed: false }))
} catch (error) {
  console.error(JSON.stringify({ code: /^(account_conversion|account_mapping|identity|backfill)_/.test(error.message) ? error.message : 'account_conversion_review_failed' }))
  process.exitCode = 1
} finally { if (connection) await connection.end().catch(() => {}) }
