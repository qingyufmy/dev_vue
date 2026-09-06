import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { createMembershipWriter } from './lib/mysql-membership-writer.mjs'
import { hash } from './lib/v4-backfill-contract.mjs'
import { membershipFixture } from '../tests/fixtures/membership-fixture.mjs'
import { writePrivateJson } from './lib/v4-backup-io.mjs'
const root = new URL('../', import.meta.url), userId = '777801', runId = 'ffffffff-ffff-4fff-8fff-ffffffffff01'
const check = (ok, code) => { if (!ok) throw new Error(code) }
let c
try {
  check(process.platform === 'linux' && process.getuid() === 0, 'membership_writer_probe_scope')
  const manifest = JSON.parse(await readFile(new URL('../tools.json', root), 'utf8'))
  for (const file of manifest) {
    check(/^[a-zA-Z0-9_./-]+$/.test(file.path) && !file.path.split('/').includes('..'), 'membership_writer_probe_path')
    check(createHash('sha256').update(await readFile(new URL(file.path, root))).digest('hex') === file.sha256, 'membership_writer_probe_file')
  }
  const mysql = createRequire(import.meta.url)('/www/wwwroot/aurum-ai/node_modules/mysql2/promise.js')
  const credentials = JSON.parse(await readFile(`/proc/self/fd/${process.env.V4_BACKUP_CREDENTIAL_FD}`, 'utf8'))
  c = await mysql.createConnection({ ...credentials, database: 'dev_vue_m1_a', dateStrings: true, timezone: 'Z', multipleStatements: false })
  const [[identity]] = await c.query('SELECT DATABASE() db,@@server_uuid uuid,VERSION() version')
  check(identity.db === 'dev_vue_m1_a' && identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'membership_writer_probe_identity')
  const counts = async () => { const [[row]] = await c.execute('SELECT (SELECT COUNT(*) FROM users WHERE id=?) users_count,(SELECT COUNT(*) FROM memberships WHERE user_id=?) memberships_count,(SELECT COUNT(*) FROM data_migration_runs WHERE id=?) runs_count', [userId, userId, runId]); return row }
  check(Object.values(await counts()).every(n => Number(n) === 0), 'membership_writer_probe_fixture_exists')
  const f = membershipFixture(); f.user.id = userId; f.options.run.id = runId
  f.options.basis.sourceHash = hash([f.user]); f.options.basis.resolutions[0].sourceId = userId; f.options.basis.resolutions[0].sourceHash = hash(f.user)
  const writer = createMembershipWriter([f.user], f.options)
  const entry = writer.prepared.entries[0]
  await c.query("SET SESSION time_zone='+00:00'")
  await c.beginTransaction()
  await c.execute("INSERT INTO users (id,password,role,plan,plan_period,plan_source,plan_expires_at,created_at,updated_at) VALUES (?,'disabled-fixture',?,?,?,?,?,UTC_TIMESTAMP(3),?)",
    [userId, f.user.role, f.user.plan, f.user.plan_period, f.user.plan_source, f.user.plan_expires_at, f.user.updated_at])
  await c.execute("INSERT INTO data_migration_runs (id,bindings_sha256,bindings_json,created_at_utc) VALUES (?,?,'{}',UTC_TIMESTAMP(3))", [runId, 'a'.repeat(64)])
  const rejects = async (expected, work) => { let code = null; try { await work() } catch (error) { code = error.message } check(code === expected, 'membership_writer_probe_rejection') }
  await rejects('membership_writer_not_committed', () => writer.write(c, entry, { verifyOnly: true }))
  const first = await writer.write(c, entry), repeat = await writer.write(c, entry, { verifyOnly: true })
  check(first.applied && !repeat.applied, 'membership_writer_probe_repeat')
  await c.query('SAVEPOINT match_writer_before_conflict')
  await c.execute("UPDATE users SET plan='free' WHERE id=?", [userId])
  await rejects('membership_writer_source_changed', () => writer.write(c, entry))
  await c.query('ROLLBACK TO SAVEPOINT match_writer_before_conflict')
  await c.execute('UPDATE memberships SET revision=2 WHERE user_id=?', [userId])
  await rejects('membership_writer_target_conflict', () => writer.write(c, entry))
  await c.rollback()
  const finalCounts = await counts()
  check(Object.values(finalCounts).every(n => Number(n) === 0), 'membership_writer_probe_rollback')
  const report = { kind: 'membership-writer-probe/v1', identity, toolManifest: manifest, fixtureOnly: true, first, repeat,
    sourceLockedAndVerified: true, missingVerifyOnlyRejected: true, sourceDriftRejected: true, membershipDriftRejected: true,
    rolledBack: true, finalCounts, currentDevVueWritten: false, realHistoricalEvidenceValidated: false }
  await writePrivateJson(new URL('../receipt.json', root).pathname, report)
  console.log(JSON.stringify({ status: 'verified', parentAndMatchDriftRejected: true, repeatNoop: true, rolledBack: true }))
} catch (error) {
  await c?.rollback().catch(() => {})
  console.error(JSON.stringify({ code: /^membership_writer_probe_[a-z_]+$/.test(error.message) ? error.message : error.code ?? 'membership_writer_probe_failed' })); process.exitCode = 1
} finally { await c?.end() }
