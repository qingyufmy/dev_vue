import { readFile, open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { updateReferralRulesInTransaction } from './referral-rule-writer.mjs'
const base = new URL('./', import.meta.url)
const sha = value => createHash('sha256').update(value).digest('hex')
const check = (ok, code) => { if (!ok) throw Error(code) }
let c
try {
  check(process.platform === 'linux' && process.getuid() === 0, 'rule_writer_probe_scope')
  const mysql = createRequire(import.meta.url)('/www/wwwroot/aurum-ai/node_modules/mysql2/promise.js')
  const credentials = JSON.parse(await readFile(`/proc/self/fd/${process.env.V4_BACKUP_CREDENTIAL_FD}`, 'utf8'))
  c = await mysql.createConnection({ ...credentials, database: 'dev_vue_m1_a', supportBigNumbers: true, bigNumberStrings: true, dateStrings: true })
  const [[identity]] = await c.query('SELECT DATABASE() db,@@server_uuid uuid,VERSION() version')
  check(identity.db === 'dev_vue_m1_a' && identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'rule_writer_probe_identity')
  const [[existing]] = await c.execute('SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', ['referral_rule_changes'])
  check(!Number(existing.n), 'rule_writer_probe_existing_table')
  const sql = await readFile(new URL('016_referral_rule_changes.sql', base), 'utf8')
  await c.query(sql)
  const [[definition]] = await c.query('SHOW CREATE TABLE referral_rule_changes')
  const readRules = async () => { const [rows] = await c.query('SELECT id,plan,period,rate_bps,enabled,CAST(revision AS CHAR) revision FROM referral_rules ORDER BY id'); return JSON.stringify(rows) }
  const before = await readRules()
  const actor = 777950
  const [[exists]] = await c.execute('SELECT COUNT(*) n FROM users WHERE id=?', [actor])
  check(!Number(exists.n), 'rule_writer_probe_fixture_collision')
  const request = { requestId: 'ffffffff-ffff-4fff-8fff-ffffffffff10', actorUserId: actor,
    changes: [{ id: 2, expectedRevision: '1', rateBps: 0, enabled: false }, { id: 1, expectedRevision: '1', rateBps: 2000, enabled: true }] }
  const start = async () => { await c.beginTransaction(); await c.execute("INSERT INTO users (id,password,created_at,updated_at) VALUES (?,'disabled-schema-fixture',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))", [actor]) }
  await start()
  const result = await updateReferralRulesInTransaction(c, request)
  const [audits] = await c.query('SELECT rule_id,CAST(rule_revision AS CHAR) rule_revision,request_id,actor_user_id,previous_rate_bps,rate_bps,previous_enabled,enabled FROM referral_rule_changes ORDER BY rule_id')
  check(JSON.stringify(result) === JSON.stringify([{ id: 1, revision: '2' }, { id: 2, revision: '2' }]), 'rule_writer_probe_result')
  check(audits.length === 2 && audits.every(row => row.rule_revision === '2' && row.actor_user_id === actor && row.previous_rate_bps === 1000 && row.previous_enabled === 1 && row.request_id === request.requestId)
    && audits[0].rate_bps === 2000 && audits[0].enabled === 1 && audits[1].rate_bps === 0 && audits[1].enabled === 0, 'rule_writer_probe_audit')
  let conflict = false
  try { await updateReferralRulesInTransaction(c, request) } catch (error) { conflict = error.message === 'referral_rule_revision_conflict' }
  check(conflict, 'rule_writer_probe_conflict')
  await c.rollback()
  await start()
  const broken = { execute: async (query, params) => { if (query.startsWith('INSERT INTO referral_rule_changes')) throw Error('injected_audit_failure'); return c.execute(query, params) } }
  let auditFailure = false
  try { await updateReferralRulesInTransaction(broken, request) } catch (error) { auditFailure = error.message === 'injected_audit_failure' }
  check(auditFailure, 'rule_writer_probe_fault_missing')
  await c.rollback()
  const [[remaining]] = await c.query('SELECT COUNT(*) n FROM referral_rule_changes')
  const [[users]] = await c.execute('SELECT COUNT(*) n FROM users WHERE id=?', [actor])
  check(before === await readRules() && !Number(remaining.n) && !Number(users.n), 'rule_writer_probe_rollback')
  const file = await open(new URL('receipt.json', base), 'wx', 0o600)
  try { await file.writeFile(JSON.stringify({ kind: 'referral-rule-writer-probe/v1', identity, sourceSqlSha256: sha(sql), ddl: definition['Create Table'],
    writerSha256: sha(await readFile(new URL('referral-rule-writer.mjs', base))), auditRowsVerified: 2, staleRevisionRejected: conflict,
    auditFailureRolledBack: auditFailure, originalRulesPreserved: true, fixturesRemoved: true, currentDevVueWritten: false }, null, 2) + '\n'); await file.sync() } finally { await file.close() }
  console.log(JSON.stringify({ status: 'verified', auditRows: 2, staleRevisionRejected: true, auditFailureRolledBack: true }))
} catch (error) {
  await c?.rollback().catch(() => {})
  console.error(JSON.stringify({ code: error.code ?? (/^rule_writer_probe_/.test(error.message) ? error.message : 'rule_writer_probe_failed') })); process.exitCode = 1
} finally { await c?.end() }
