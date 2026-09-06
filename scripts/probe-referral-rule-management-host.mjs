import { readFile, open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { MysqlReferralRuleManagement } from './modules/commerce/infrastructure/mysql-referral-rule-management.js'
const base = new URL('./', import.meta.url)
const sha = value => createHash('sha256').update(value).digest('hex')
const check = (ok, code) => { if (!ok) throw Error(code) }
const actor = 777952
const requestIds = [11, 12, 13, 14].map(n => `ffffffff-ffff-4fff-8fff-ffffffffff${n}`)
let c, pool
try {
  check(process.platform === 'linux' && process.getuid() === 0, 'rule_management_probe_scope')
  const mysql = createRequire(import.meta.url)('/www/wwwroot/aurum-ai/node_modules/mysql2/promise.js')
  const credentials = JSON.parse(await readFile(`/proc/self/fd/${process.env.V4_BACKUP_CREDENTIAL_FD}`, 'utf8'))
  pool = mysql.createPool({ ...credentials, database: 'dev_vue_m1_a', supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, connectionLimit: 4 })
  c = await pool.getConnection()
  const [[identity]] = await c.query('SELECT DATABASE() db,@@server_uuid uuid,VERSION() version')
  check(identity.db === 'dev_vue_m1_a' && identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'rule_management_probe_identity')
  const [[existing]] = await c.execute('SELECT COUNT(*) n FROM users WHERE id=?', [actor])
  const [[oldAudit]] = await c.query('SELECT COUNT(*) n FROM referral_rule_changes')
  check(!Number(existing.n) && !Number(oldAudit.n), 'rule_management_probe_fixture_conflict')
  const readRules = async () => { const [rows] = await c.query('SELECT id,plan,period,rate_bps,enabled,CAST(revision AS CHAR) revision FROM referral_rules ORDER BY id'); return rows.map(row => ({ ...row })) }
  const before = await readRules()
  check(before.length === 4 && before.every(row => row.revision === '1'), 'rule_management_probe_source')
  await c.execute("INSERT INTO users (id,password,role,deletion_status,deleted_at,created_at,updated_at) VALUES (?,'disabled-schema-fixture','admin','active',NULL,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))", [actor])
  const connections = new Set()
  const tracedPool = { async getConnection() { const connection = await pool.getConnection(); connections.add(connection.threadId); return connection } }
  const repository = new MysqlReferralRuleManagement(tracedPool)
  const first = { requestId: requestIds[0], actorUserId: actor, changes: [
    { id: 2, expectedRevision: '1', rateBps: 0, enabled: false }, { id: 1, expectedRevision: '1', rateBps: 2000, enabled: true }] }
  const duplicates = await Promise.all([repository.execute(first), repository.execute(first)])
  check(duplicates.filter(result => result.replayed).length === 1 && connections.size >= 2, 'rule_management_probe_duplicate')
  const races = await Promise.allSettled(requestIds.slice(1, 3).map((requestId, index) => repository.execute({ requestId, actorUserId: actor,
    changes: [{ id: 1, expectedRevision: '2', rateBps: 2100 + index, enabled: true }] })))
  check(races.filter(row => row.status === 'fulfilled').length === 1
    && races.filter(row => row.status === 'rejected' && row.reason.message === 'referral_rule_revision_conflict').length === 1, 'rule_management_probe_race')
  const lost = { requestId: requestIds[3], actorUserId: actor, changes: [{ id: 2, expectedRevision: '2', rateBps: 3000, enabled: true }] }
  const faultPool = { async getConnection() {
    const connection = await pool.getConnection(), commit = connection.commit.bind(connection)
    connection.commit = async () => { await commit(); connection.destroy(); throw Error('injected_commit_response_lost') }
    return connection
  } }
  let unknown = false
  try { await new MysqlReferralRuleManagement(faultPool).execute(lost) } catch (error) { unknown = error.message === 'referral_rule_commit_unknown' }
  check(unknown, 'rule_management_probe_unknown')
  const recovered = await repository.execute(lost)
  check(recovered.replayed && recovered.rules[0].revision === '3', 'rule_management_probe_recovery')
  let changedRejected = false
  try { await repository.execute({ ...lost, changes: [{ ...lost.changes[0], rateBps: 3001 }] }) } catch (error) { changedRejected = error.message === 'referral_rule_idempotency_conflict' }
  check(changedRejected, 'rule_management_probe_changed_request')
  const [audits] = await c.execute('SELECT rule_id,CAST(rule_revision AS CHAR) revision,request_id,actor_user_id FROM referral_rule_changes ORDER BY rule_id,rule_revision')
  check(audits.length === 4 && audits.every(row => row.actor_user_id === actor && requestIds.includes(row.request_id)), 'rule_management_probe_audit_count')
  const final = await readRules()
  check(final[0].revision === '3' && final[1].revision === '3'
    && JSON.stringify(final.slice(2)) === JSON.stringify(before.slice(2)), 'rule_management_probe_final_rules')
  await c.beginTransaction()
  const [removed] = await c.execute('DELETE FROM referral_rule_changes WHERE actor_user_id=? AND request_id IN (?,?,?,?)', [actor, ...requestIds])
  check(removed.affectedRows === 4, 'rule_management_probe_cleanup_audits')
  for (const row of before.slice(0, 2)) {
    const [restored] = await c.execute('UPDATE referral_rules SET rate_bps=?,enabled=?,revision=? WHERE id=? AND revision=?', [row.rate_bps, row.enabled, row.revision, row.id, '3'])
    check(restored.affectedRows === 1, 'rule_management_probe_cleanup_revision')
  }
  await c.execute('DELETE FROM users WHERE id=?', [actor]); await c.commit()
  const [[remaining]] = await c.query('SELECT COUNT(*) n FROM referral_rule_changes')
  const [[remainingActor]] = await c.execute('SELECT COUNT(*) n FROM users WHERE id=?', [actor])
  check(!Number(remaining.n) && !Number(remainingActor.n) && JSON.stringify(await readRules()) === JSON.stringify(before), 'rule_management_probe_cleanup')
  const sourceFiles = []
  for (const path of ['modules/commerce/infrastructure/mysql-referral-rule-management.js', 'modules/commerce/infrastructure/mysql-referral-rule-writer.js', 'modules/commerce/application/referral-rule-management.js'])
    sourceFiles.push({ path, sha256: sha(await readFile(new URL(path, base))) })
  const file = await open(new URL('receipt.json', base), 'wx', 0o600)
  try { await file.writeFile(JSON.stringify({ kind: 'referral-rule-management-probe/v1', identity, sourceFiles,
    concurrentConnections: connections.size, duplicateAppliedOnce: true, competingRevisionRejected: true, commitResponseLostRecovered: true,
    changedRequestRejected: true, auditRowsVerified: 4, originalRulesPreserved: true, fixturesRemoved: true, currentDevVueWritten: false }, null, 2) + '\n'); await file.sync() } finally { await file.close() }
  console.log(JSON.stringify({ status: 'verified', concurrentConnections: connections.size, auditRows: 4, recovered: true, fixturesRemoved: true }))
} catch (error) {
  await c?.rollback().catch(() => {})
  console.error(JSON.stringify({ code: error.code ?? (/^rule_management_probe_/.test(error.message) ? error.message : 'rule_management_probe_failed') })); process.exitCode = 1
} finally { c?.release(); await pool?.end() }
