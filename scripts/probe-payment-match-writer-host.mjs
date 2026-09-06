import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { createPaymentMatchWriter } from './lib/mysql-payment-match-writer.mjs'
import { createPaymentOrderWriter } from './lib/mysql-payment-order-writer.mjs'
import { paymentMatchFactFields, reconcilePaymentMatchFacts } from './lib/v4-payment-match-fact-audit.mjs'
import { paymentMatchFixture } from '../tests/fixtures/payment-match-fixture.mjs'
import { writePrivateJson } from './lib/v4-backup-io.mjs'
const root = new URL('../', import.meta.url), userId = '777404', runId = 'ffffffff-ffff-4fff-8fff-fffffffffff9'
const check = (ok, code) => { if (!ok) throw new Error(code) }
let c
try {
  check(process.platform === 'linux' && process.getuid() === 0, 'match_writer_probe_scope')
  const manifest = JSON.parse(await readFile(new URL('../tools.json', root), 'utf8'))
  for (const file of manifest) {
    check(/^[a-zA-Z0-9_./-]+$/.test(file.path) && !file.path.split('/').includes('..'), 'match_writer_probe_path')
    check(createHash('sha256').update(await readFile(new URL(file.path, root))).digest('hex') === file.sha256, 'match_writer_probe_file')
  }
  const mysql = createRequire(import.meta.url)('/www/wwwroot/aurum-ai/node_modules/mysql2/promise.js')
  const credentials = JSON.parse(await readFile(`/proc/self/fd/${process.env.V4_BACKUP_CREDENTIAL_FD}`, 'utf8'))
  c = await mysql.createConnection({ ...credentials, database: 'dev_vue_m1_a', dateStrings: true, timezone: 'Z', multipleStatements: false })
  const [[identity]] = await c.query('SELECT DATABASE() db,@@server_uuid uuid,VERSION() version')
  check(identity.db === 'dev_vue_m1_a' && identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'match_writer_probe_identity')
  const counts = async () => { const [[row]] = await c.execute('SELECT (SELECT COUNT(*) FROM users WHERE id=?) users_count,(SELECT COUNT(*) FROM payment_orders WHERE id=?) orders_count,(SELECT COUNT(*) FROM payment_matches WHERE id=?) matches_count,(SELECT COUNT(*) FROM data_migration_runs WHERE id=?) runs_count', [userId, userId, userId, runId]); return row }
  check(Object.values(await counts()).every(n => Number(n) === 0), 'match_writer_probe_fixture_exists')
  const f = paymentMatchFixture({ userId, orderTargetId: userId, matchTargetId: userId }); f.options.run.id = runId
  const parent = createPaymentOrderWriter([f.order], f.options.orderOptions), writer = createPaymentMatchWriter([f.watch], [f.order], f.options)
  const entry = writer.prepared.entries[0]
  await c.query("SET SESSION time_zone='+00:00'")
  await c.beginTransaction()
  await c.execute("INSERT INTO users (id,password,created_at,updated_at) VALUES (?,'disabled-fixture',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))", [userId])
  await c.execute("INSERT INTO data_migration_runs (id,bindings_sha256,bindings_json,created_at_utc) VALUES (?,?,'{}',UTC_TIMESTAMP(3))", [runId, 'a'.repeat(64)])
  const rejects = async (expected, work) => { let code = null; try { await work() } catch (error) { code = error.message } check(code === expected, 'match_writer_probe_rejection') }
  await rejects('payment_order_writer_not_committed', () => writer.write(c, entry))
  await parent.write(c, parent.prepared.entries[0])
  await rejects('payment_match_writer_not_committed', () => writer.write(c, entry, { verifyOnly: true }))
  const first = await writer.write(c, entry), repeat = await writer.write(c, entry, { verifyOnly: true })
  check(first.applied && !repeat.applied, 'match_writer_probe_repeat')
  const projection = paymentMatchFactFields.map(field => ['legacy_watch_id', 'user_id', 'required_confirmations', 'legacy_confirmations', 'legacy_wallet_index'].includes(field) ? `CAST(${field} AS CHAR) ${field}` : field).join(',')
  const [rows] = await c.execute(`SELECT ${projection} FROM payment_matches WHERE id=?`, [userId])
  const audit = reconcilePaymentMatchFacts([f.watch], [f.order], rows.map(row => ({ ...row })), '+00:00')
  check(audit.sourceFactsMatch, 'match_writer_probe_audit')
  await c.query('SAVEPOINT match_writer_before_conflict')
  await c.execute('UPDATE payment_orders SET revision=2 WHERE id=?', [userId])
  await rejects('payment_order_writer_target_conflict', () => writer.write(c, entry))
  await c.query('ROLLBACK TO SAVEPOINT match_writer_before_conflict')
  await c.execute('UPDATE payment_matches SET expected_amount=2 WHERE id=?', [userId])
  await rejects('payment_match_writer_target_conflict', () => writer.write(c, entry))
  await c.rollback()
  const finalCounts = await counts()
  check(Object.values(finalCounts).every(n => Number(n) === 0), 'match_writer_probe_rollback')
  const report = { kind: 'payment-match-writer-probe/v1', identity, toolManifest: manifest, fixtureOnly: true, first, repeat, audit,
    missingParentRejected: true, missingVerifyOnlyRejected: true, parentDriftRejected: true, matchDriftRejected: true,
    rolledBack: true, finalCounts, currentDevVueWritten: false, realHistoricalEvidenceValidated: false }
  await writePrivateJson(new URL('../receipt.json', root).pathname, report)
  console.log(JSON.stringify({ status: 'verified', parentAndMatchDriftRejected: true, repeatNoop: true, rolledBack: true }))
} catch (error) {
  await c?.rollback().catch(() => {})
  console.error(JSON.stringify({ code: /^match_writer_probe_[a-z_]+$/.test(error.message) ? error.message : error.code ?? 'match_writer_probe_failed' })); process.exitCode = 1
} finally { await c?.end() }
