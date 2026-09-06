import { readFile, open } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { hash } from './lib/v4-backfill-contract.mjs'
import { paymentOrderFields } from './lib/v4-payment-order-source.mjs'
import { createPaymentOrderWriter } from './lib/mysql-payment-order-writer.mjs'
import { paymentOrderFactFields, reconcilePaymentOrderFacts } from './lib/v4-payment-order-fact-audit.mjs'
const base = new URL('./', import.meta.url), userId = '777101', targetId = '777101', runId = 'ffffffff-ffff-4fff-8fff-fffffffffff6'
const check = (ok, code) => { if (!ok) throw new Error(code) }
let c
try {
  check(process.platform === 'linux' && process.getuid() === 0, 'payment_writer_probe_scope')
  const toolManifest = JSON.parse(await readFile(new URL('tools.json', base), 'utf8'))
  check(Array.isArray(toolManifest) && toolManifest.length === 10 && new Set(toolManifest.map(file => file.path)).size === 10, 'payment_writer_probe_manifest')
  for (const file of toolManifest) {
    check(/^(?:lib\/)?[a-z0-9.-]+$/.test(file.path), 'payment_writer_probe_path')
    check(createHash('sha256').update(await readFile(new URL(file.path, base))).digest('hex') === file.sha256, 'payment_writer_probe_file_changed')
  }
  const mysql = createRequire(import.meta.url)('/www/wwwroot/aurum-ai/node_modules/mysql2/promise.js')
  const credentials = JSON.parse(await readFile(`/proc/self/fd/${process.env.V4_BACKUP_CREDENTIAL_FD}`, 'utf8'))
  c = await mysql.createConnection({ ...credentials, database: 'dev_vue_m1_a', dateStrings: true, timezone: 'Z', multipleStatements: false })
  const [[identity]] = await c.query('SELECT DATABASE() db,@@server_uuid uuid,VERSION() version')
  check(identity.db === 'dev_vue_m1_a' && identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'payment_writer_probe_identity')
  const counts = async () => { const [[row]] = await c.execute('SELECT (SELECT COUNT(*) FROM users WHERE id=?) users_count,(SELECT COUNT(*) FROM payment_orders WHERE id=?) orders_count,(SELECT COUNT(*) FROM data_migration_runs WHERE id=?) runs_count', [userId, targetId, runId]); return row }
  check(Object.values(await counts()).every(n => Number(n) === 0), 'payment_writer_probe_fixture_exists')
  await c.query("SET SESSION time_zone='+00:00'")
  await c.beginTransaction()
  await c.execute("INSERT INTO users (id,password,created_at,updated_at) VALUES (?,'disabled-schema-fixture',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))", [userId])
  await c.execute("INSERT INTO data_migration_runs (id,bindings_sha256,bindings_json,created_at_utc) VALUES (?,?,'{}',UTC_TIMESTAMP(3))", [runId, 'a'.repeat(64)])
  const source = { ...Object.fromEntries(Object.entries(paymentOrderFields).map(([key, [, nullable]]) => [key, nullable ? null : '0'])),
    id: '1', user_id: userId, order_no: 'writer-fixture', order_id: 'writer-fixture-external', plan: 'plus', status: 'cancelled', currency: 'USD',
    amount: '300', amount_confirmed: '1', referral_credit_applied: '0', created_at: '2026-09-06 12:00:00' }
  const writer = createPaymentOrderWriter([source], { userIds: new Set([userId]), idMap: new Map([['1', targetId]]),
    run: { id: runId, sourceSnapshotId: 'synthetic-only', registeredAtUtc: '2026-09-07T00:00:00.000Z' }, evidenceCatalog: new Map([['synthetic-only', 'b'.repeat(64)]]),
    timeBasis: { version: 'payment-order-time/v1', sourceTable: 'orders', sourceHash: hash([source]), sourceSnapshotId: 'synthetic-only',
      resolutions: [{ sourceId: '1', sourceHash: hash(source), field: 'created_at', raw: source.created_at, offsetMinutes: 480, evidenceId: 'synthetic-only', evidenceSha256: 'b'.repeat(64) }] } })
  const entry = writer.prepared.entries[0], first = await writer.write(c, entry), repeated = await writer.write(c, entry, { verifyOnly: true })
  check(first.applied && !repeated.applied, 'payment_writer_probe_repeat')
  const projection = paymentOrderFactFields.map(field => ['legacy_order_id', 'user_id'].includes(field) ? `CAST(${field} AS CHAR) ${field}` : field).join(',')
  const [actual] = await c.execute(`SELECT ${projection} FROM payment_orders WHERE id=?`, [targetId])
  const audit = reconcilePaymentOrderFacts([source], actual.map(row => ({ ...row })), new Set([userId]))
  check(audit.sourceFactsMatch, 'payment_writer_probe_fact_audit')
  await c.execute('UPDATE payment_orders SET legacy_amount_confirmed=2 WHERE id=?', [targetId])
  let conflict = null
  try { await writer.write(c, entry) } catch (error) { conflict = error.message }
  check(conflict === 'payment_order_writer_target_conflict', 'payment_writer_probe_conflict')
  await c.rollback()
  check(Object.values(await counts()).every(n => Number(n) === 0), 'payment_writer_probe_rollback')
  await c.beginTransaction()
  let missing = null
  try { await writer.write(c, entry, { verifyOnly: true }) } catch (error) { missing = error.message }
  check(missing === 'payment_order_writer_not_committed', 'payment_writer_probe_verify_only')
  await c.rollback()
  const finalCounts = await counts()
  check(Object.values(finalCounts).every(n => Number(n) === 0), 'payment_writer_probe_residual')
  const report = { kind: 'payment-order-writer-probe/v1', identity, toolManifest, fixtureOnly: true, first, repeated, audit,
    conflictRejected: true, missingVerifyOnlyRejected: true, rolledBack: true, finalCounts, sourceDatabaseWritten: false, realHistoricalTimeValidated: false }
  const file = await open(new URL('receipt.json', base), 'wx', 0o600)
  try { await file.writeFile(JSON.stringify(report, null, 2) + '\n'); await file.sync() } finally { await file.close() }
  console.log(JSON.stringify({ status: 'verified', repeatedWithoutInsert: true, conflictRejected: true, rolledBack: true }))
} catch (error) {
  await c?.rollback().catch(() => {})
  console.error(JSON.stringify({ code: /^payment_writer_probe_[a-z_]+$/.test(error.message) ? error.message : error.code ?? 'payment_writer_probe_failed' })); process.exitCode = 1
} finally { await c?.end() }
