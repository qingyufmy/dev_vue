import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readCurrentMembership } from '../server/dist-v4/modules/commerce/infrastructure/mysql-membership-reader.js'
import { evaluateMembership } from '../server/dist-v4/modules/commerce/domain/membership.js'
import { writePrivateJson } from './lib/v4-backup-io.mjs'
const root = new URL('../', import.meta.url), userId = 777901
const check = (ok, code) => { if (!ok) throw new Error(code) }
let c
try {
  check(process.platform === 'linux' && process.getuid() === 0, 'membership_reader_probe_scope')
  const manifest = JSON.parse(await readFile(new URL('../tools.json', root), 'utf8'))
  for (const file of manifest) {
    check(/^[a-zA-Z0-9_./-]+$/.test(file.path) && !file.path.split('/').includes('..'), 'membership_reader_probe_path')
    check(createHash('sha256').update(await readFile(new URL(file.path, root))).digest('hex') === file.sha256, 'membership_reader_probe_file')
  }
  const mysql = createRequire(import.meta.url)('/www/wwwroot/aurum-ai/node_modules/mysql2/promise.js')
  const credentials = JSON.parse(await readFile(`/proc/self/fd/${process.env.V4_BACKUP_CREDENTIAL_FD}`, 'utf8'))
  c = await mysql.createConnection({ ...credentials, database: 'dev_vue_m1_a', dateStrings: true, timezone: 'Z' })
  const [[identity]] = await c.query('SELECT DATABASE() db,@@server_uuid uuid,VERSION() version')
  check(identity.db === 'dev_vue_m1_a' && identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'membership_reader_probe_identity')
  const counts = async () => { const [[row]] = await c.execute('SELECT (SELECT COUNT(*) FROM users WHERE id=?) users_count,(SELECT COUNT(*) FROM memberships WHERE user_id=?) memberships_count', [userId, userId]); return row }
  check(Object.values(await counts()).every(n => Number(n) === 0), 'membership_reader_probe_fixture_exists')
  await c.query("SET SESSION time_zone='+00:00'")
  await c.beginTransaction()
  check(await readCurrentMembership(c, userId) === null, 'membership_reader_probe_missing')
  await c.execute("INSERT INTO users (id,password,created_at,updated_at) VALUES (?,'disabled-fixture',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))", [userId])
  await c.execute("INSERT INTO memberships (user_id,plan_code,billing_period_code,source_code,expiration_kind,expires_at_utc,current_state_observed_at_utc,revision,origin) VALUES (?,'pro','',NULL,'at_time','2026-09-07 01:00:00.123',UTC_TIMESTAMP(3),'9007199254740993','native')", [userId])
  const timed = await readCurrentMembership(c, userId)
  check(timed?.expiresAtUtc === '2026-09-07T01:00:00.123Z' && timed.revision === '9007199254740993'
    && timed.billingPeriodCode === '' && timed.sourceCode === null, 'membership_reader_probe_roundtrip')
  check(evaluateMembership(timed, new Date('2026-09-07T01:00:00.122Z')).effectivePlan === 'pro'
    && evaluateMembership(timed, new Date('2026-09-07T01:00:00.123Z')).effectivePlan === 'free', 'membership_reader_probe_boundary')
  await c.execute("UPDATE memberships SET expiration_kind='no_expiry',expires_at_utc=NULL WHERE user_id=?", [userId])
  const unbounded = await readCurrentMembership(c, userId)
  check(unbounded?.expiresAtUtc === null && evaluateMembership(unbounded, new Date('2026-09-07T02:00:00.000Z')).effectivePlan === 'pro', 'membership_reader_probe_null')
  await c.rollback()
  const finalCounts = await counts()
  check(Object.values(finalCounts).every(n => Number(n) === 0), 'membership_reader_probe_rollback')
  await writePrivateJson(new URL('../receipt.json', root).pathname, { kind: 'membership-reader-probe/v1', identity, toolManifest: manifest,
    fixtureOnly: true, exactRevisionAndMilliseconds: true, nullAndEmptyPreserved: true, boundaryVerified: true,
    missingRowIsNull: true, rolledBack: true, finalCounts, currentDevVueWritten: false, consumersSwitched: false })
  console.log(JSON.stringify({ status: 'verified', exactRevisionAndMilliseconds: true, boundaryVerified: true, rolledBack: true }))
} catch (error) {
  await c?.rollback().catch(() => {})
  console.error(JSON.stringify({ code: /^membership_reader_probe_[a-z_]+$/.test(error.message) ? error.message : error.code ?? 'membership_reader_probe_failed' })); process.exitCode = 1
} finally { await c?.end() }
