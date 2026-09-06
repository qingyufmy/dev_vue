import { readFile, writeFile } from 'node:fs/promises'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import { readWalletTargetIdentity } from './lib/mysql-wallet-backfill.mjs'
import { inspectWalletAddressSources } from './lib/v4-wallet-address-source.mjs'
import { hash, requireBackfill as check } from './lib/v4-backfill-contract.mjs'
const root = new URL('../', import.meta.url)
const reportPath = new URL('docs/migration/dev-vue-wallet-backfill-readiness-20260907.json', root)
let connection
try {
  const mode = process.argv[2]
  check(process.argv.length === 3 && ['--write', '--verify'].includes(mode), 'wallet_readiness_arguments')
  const env = parse(await readFile(new URL('server/.env', root)))
  const backup = JSON.parse(await readFile(new URL('docs/migration/dev-vue-inplace-backup-20260906.json', root)))
  const prior = JSON.parse(await readFile(new URL('docs/migration/dev-vue-wallet-address-source-review-20260907.json', root)))
  check(env.MYSQL_DATABASE === 'dev_vue', 'wallet_readiness_scope')
  connection = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: 'dev_vue', dateStrings: true, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true })
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  const identity = await readWalletTargetIdentity(connection)
  check(identity.serverUuid === backup.serverUuid, 'wallet_readiness_identity')
  const [raw] = await connection.query('SELECT CAST(id AS CHAR) id,chain,CAST(address_index AS CHAR) address_index,address,created_at FROM wallet_keys ORDER BY wallet_keys.id')
  const source = inspectWalletAddressSources(raw.map(row => ({ ...row })))
  check(source.sourceHash === prior.result.sourceHash, 'wallet_readiness_source_changed')
  const [[counts]] = await connection.query('SELECT (SELECT COUNT(*) FROM payment_wallet_addresses) targetRows,(SELECT COUNT(*) FROM database_upgrade_steps_v4 WHERE status=\'completed\') completedSteps')
  const report = { kind: 'wallet-backfill-readiness/v1', identity, sourceRows: raw.length, sourceHash: source.sourceHash,
    counts, blockers: source.blockers, databaseWritten: false, actualBackfillVerified: false }
  await connection.rollback()
  if (mode === '--write') await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  else check(hash(report) === hash(JSON.parse(await readFile(reportPath))), 'wallet_readiness_changed')
  console.log(JSON.stringify({ status: 'verified', sourceRows: raw.length, ...counts, databaseWritten: false }))
} catch (error) {
  console.error(JSON.stringify({ code: /^wallet_readiness_[a-z_]+$/.test(error.message) ? error.message : 'wallet_readiness_failed' }))
  process.exitCode = 1
} finally { if (connection) { await connection.rollback().catch(() => {}); await connection.end().catch(() => {}) } }
