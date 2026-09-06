import { readFile, writeFile } from 'node:fs/promises'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import { hash } from './lib/v4-backfill-contract.mjs'
import { loadUserDefaultsCoordinator, verifyOriginalSchemaWithUserDefaults } from './lib/inplace-user-defaults.mjs'
import { coordinateInplaceSchema } from './lib/inplace-schema-coordinator.mjs'
import { verifyInplaceJournal } from './lib/mysql-inplace-column-store.mjs'
import { validateColumnEvidence, readOriginalRows } from './lib/inplace-column-evidence.mjs'
import { convertReferralAccounts } from './lib/v4-referral-conversion.mjs'

const root = new URL('../', import.meta.url)
const path = 'docs/migration/dev-vue-referral-source-review-20260907.json'
const json = async name => JSON.parse(await readFile(new URL(name, root), 'utf8'))
const check = (ok, code) => { if (!ok) throw new Error(code) }
let connection
try {
  const [mode] = process.argv.slice(2)
  check(process.argv.length === 3 && ['--write', '--verify'].includes(mode), 'referral_review_arguments')
  const previous = mode === '--verify' ? await json(path) : null
  const registeredAtUtc = previous?.candidateRegistrationTimeUtc ?? new Date().toISOString()
  const backup = await json('docs/migration/dev-vue-inplace-backup-20260906.json')
  const columns = await json('docs/migration/dev-vue-inplace-column-rehearsal-20260906.json')
  validateColumnEvidence(backup, columns)
  const plan = await loadUserDefaultsCoordinator(root)
  const env = parse(await readFile(new URL('server/.env', root)))
  check(env.MYSQL_DATABASE === 'dev_vue', 'referral_review_database')
  connection = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: 'dev_vue', dateStrings: true, jsonStrings: true, timezone: 'Z',
    supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false })
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  check(identity.db === 'dev_vue' && identity.uuid === backup.serverUuid, 'referral_review_identity')
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  check(await verifyInplaceJournal(connection), 'referral_review_journal')
  check((await coordinateInplaceSchema(plan.store(connection), plan)).structureComplete, 'referral_review_schema')
  await verifyOriginalSchemaWithUserDefaults(connection, backup.schemaSha256, [...new Set(plan.steps.filter(s => !s.column).map(s => s.table))])
  check(JSON.stringify(await readOriginalRows(connection, columns.originalColumns)) === JSON.stringify(columns.parity), 'referral_review_original_changed')
  const [data] = await connection.query('SELECT CAST(id AS CHAR) id,referral_code,referred_by,referral_credit,created_at,updated_at FROM users ORDER BY id')
  const rows = data.map(row => ({ ...row }))
  const converted = convertReferralAccounts(rows, registeredAtUtc)
  // MySQL performs equality with the actual source collation, not JS case folding.
  const [[duplicates]] = await connection.query('SELECT COUNT(*) groups_count,COALESCE(SUM(n),0) affected_users FROM (SELECT COUNT(*) n FROM users WHERE referral_code IS NOT NULL GROUP BY referral_code HAVING COUNT(*)>1) d')
  const [[relations]] = await connection.query("SELECT COALESCE(SUM(matches_count=0),0) unmatched,COALESCE(SUM(matches_count>1),0) ambiguous FROM (SELECT (SELECT COUNT(*) FROM users p WHERE p.referral_code=u.referred_by) matches_count FROM users u WHERE u.referred_by IS NOT NULL AND u.referred_by<>'') d")
  const [[target]] = await connection.query("SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='user_referral_accounts'")
  await connection.rollback()
  const report = { kind: 'referral-source-review/v1', identity, schemaSteps: plan.steps.length,
    originalTablesVerified: columns.parity.length, originalRowsVerified: backup.parity.rows,
    candidateRegistrationTimeUtc: registeredAtUtc, conversionVersion: converted.version,
    sourceProjectionHash: converted.sourceHash, candidateTargetsHash: hash(converted.entries.map(e => e.target)),
    sourceUsers: rows.length, candidateRows: converted.sourceCount, totalCreditUnits: converted.totalCreditUnits, creditScale: 8,
    negativeBalances: rows.filter(r => r.referral_credit.startsWith('-') && /[1-9]/.test(r.referral_credit)).length,
    nullReferralCodes: rows.filter(r => r.referral_code === null).length, emptyReferralCodes: rows.filter(r => r.referral_code === '').length,
    nullReferredBy: rows.filter(r => r.referred_by === null).length, emptyReferredBy: rows.filter(r => r.referred_by === '').length,
    duplicateCodeGroups: String(duplicates.groups_count), duplicateCodeUsers: String(duplicates.affected_users),
    unmatchedNonemptyReferrals: String(relations.unmatched), ambiguousNonemptyReferrals: String(relations.ambiguous),
    targetTablePresent: Number(target.n) === 1, databaseWrites: 0, businessBackfillComplete: false,
    remainingChecks: ['target_schema_rehearsal', 'transactional_writer_and_receipts', 'independent_target_readback', 'financial_write_protocol'],
    fullNormalizationComplete: false }
  if (mode === '--write') await writeFile(new URL(path, root), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  else check(JSON.stringify(previous) === JSON.stringify(report), 'referral_review_changed')
  console.log(JSON.stringify({ status: 'verified', sourceUsers: rows.length, candidateRows: converted.sourceCount,
    duplicateCodeGroups: report.duplicateCodeGroups, ambiguousNonemptyReferrals: report.ambiguousNonemptyReferrals,
    targetTablePresent: report.targetTablePresent, databaseWrites: 0 }))
} catch (error) {
  console.error(JSON.stringify({ code: /^referral_[a-z_]+$/.test(error.message) ? error.message : 'referral_review_failed' }))
  process.exitCode = 1
} finally {
  if (connection) { await connection.rollback().catch(() => {}); await connection.end().catch(() => {}) }
}
