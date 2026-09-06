import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { evaluateMembership } from '../server/dist-v4/modules/commerce/domain/membership.js'
import { readFile, writeFile } from 'node:fs/promises'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import { hash } from './lib/v4-backfill-contract.mjs'
import { paymentEffectFields } from './lib/v4-payment-effects-source.mjs'
import { loadMembershipCoordinator } from './lib/inplace-membership-schema.mjs'
import { inspectMembershipSources, membershipSourceFields } from './lib/v4-membership-source.mjs'
import { paymentOrderFields } from './lib/v4-payment-order-source.mjs'
import { coordinateInplaceSchema } from './lib/inplace-schema-coordinator.mjs'
import { verifyInplaceJournal } from './lib/mysql-inplace-column-store.mjs'
import { verifyOriginalSchemaWithUserDefaults } from './lib/inplace-user-defaults.mjs'

const root = new URL('../', import.meta.url)
const reportPath = new URL('docs/migration/dev-vue-null-membership-review-20260907.json', root)
const check = (ok, code) => { if (!ok) throw new Error(code) }
let connection
try {
  const [mode] = process.argv.slice(2)
  check(process.argv.length === 3 && ['--write', '--verify'].includes(mode), 'payment_effect_arguments')
  const previous = mode === '--verify' ? JSON.parse(await readFile(reportPath, 'utf8')) : null
  const backup = JSON.parse(await readFile(new URL('docs/migration/dev-vue-inplace-backup-20260906.json', root), 'utf8'))
  const plan = await loadMembershipCoordinator(root)
  const env = parse(await readFile(new URL('server/.env', root)))
  check(env.MYSQL_DATABASE === 'dev_vue', 'payment_effect_database')
  connection = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: 'dev_vue', dateStrings: true, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true })
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  check(identity.db === 'dev_vue' && identity.uuid === backup.serverUuid, 'payment_effect_identity')
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  check(await verifyInplaceJournal(connection), 'payment_effect_journal')
  check((await coordinateInplaceSchema(plan.store(connection), plan)).structureComplete, 'payment_effect_schema')
  await verifyOriginalSchemaWithUserDefaults(connection, backup.schemaSha256, [...new Set(plan.steps.filter(s => !s.column).map(s => s.table))])
  const read = async (table, fields) => {
    const projection = Object.entries(fields).map(([key, [type]]) => ['int', 'bigint'].includes(type) ? `CAST(\`${key}\` AS CHAR) AS \`${key}\`` : `\`${key}\``).join(',')
    const [rows] = await connection.query(`SELECT ${projection} FROM ${table} ORDER BY ${table}.id`)
    return rows.map(row => ({ ...row }))
  }
  const users = await read('users', membershipSourceFields), orders = await read('orders', paymentOrderFields), effects = await read('payment_side_effects', paymentEffectFields)
  const selected = users.filter(user => user.plan_expires_at === null)
  const result = inspectMembershipSources(selected, [], [])
  check(result.entries.every(entry => ['free', 'plus', 'pro'].includes(entry.source.plan)), 'payment_effect_unknown_plan')
  const referencePath = 'D:/dev_codex/wall-street-skill-local/server/membership.js'
  const referenceBytes = await readFile(referencePath)
  const reference = await import(pathToFileURL(referencePath).href)
  const observedAt = new Date('2026-09-07T00:00:00.000Z')
  const policyCases = ['free', 'plus', 'pro'].map(plan => {
    const legacy = reference.getEffectivePlan({ plan, plan_expires_at: null }, observedAt.getTime())
    const normalized = evaluateMembership({ userId: 1, planCode: plan, billingPeriodCode: null, sourceCode: null,
      expirationKind: 'no_expiry', expiresAtUtc: null, revision: '1' }, observedAt).effectivePlan
    check(legacy === plan && normalized === legacy, 'payment_effect_null_policy_mismatch')
    return { plan, legacy, normalized }
  })
  const report = { kind: 'membership-null-expiry-review/v1', identity, schemaSteps: plan.steps.length,
    sourceProjection: 'membership-source/v1', sourceHash: result.sourceHash, sourceRows: selected.length,
    allUserSourceHash: hash(users), allUserRows: users.length, deferredNonNullExpiryRows: users.length - selected.length,
    plans: [...new Set(selected.map(row => row.plan))].sort().map(plan => ({ plan, rows: selected.filter(row => row.plan === plan).length })),
    rule: { sourcePredicate: 'plan_expires_at IS NULL', targetExpirationKind: 'no_expiry', targetExpiresAtUtc: null,
      sourceUpdatedAtDisposition: 'preserve_raw_archive', observedAtDisposition: 'migration_registration_time',
      createsPurchaseOrHistoricalGrant: false, convertsHistoricalTime: false },
    policyCases, referencePath, referenceSha256: createHash('sha256').update(referenceBytes).digest('hex'),
    normalizedDomainSourceSha256: createHash('sha256').update(await readFile(new URL('server/src/modules/commerce/domain/membership.ts', root))).digest('hex'),
    normalizedDomainBuildSha256: createHash('sha256').update(await readFile(new URL('server/dist-v4/modules/commerce/domain/membership.js', root))).digest('hex'),
    sourceDatabaseWritten: false, businessCutoverAuthorized: false, fullMembershipConverted: false }
  await connection.rollback()
  if (mode === '--write') await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  else check(JSON.stringify(previous) === JSON.stringify(report), 'payment_effect_review_changed')
  console.log(JSON.stringify({ status: 'verified', rows: selected.length, deferred: report.deferredNonNullExpiryRows, plans: report.plans, blockers: [...new Set(result.blockers.map(b => b.code))], databaseWrites: 0 }))
} catch (error) {
  console.error(JSON.stringify({ code: /^payment_effect_[a-z_]+$/.test(error.message) ? error.message : 'payment_effect_review_failed' }))
  process.exitCode = 1
} finally {
  if (connection) { await connection.rollback().catch(() => {}); await connection.end().catch(() => {}) }
}
