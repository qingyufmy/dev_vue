import { readFile, open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
const base = new URL('./', import.meta.url)
const sha = value => createHash('sha256').update(value).digest('hex')
const check = (ok, code) => { if (!ok) throw new Error(code) }
let connection
try {
  check(process.platform === 'linux' && process.getuid() === 0, 'rule_probe_scope')
  const sql = await readFile(new URL('015_referral_rule_constraints.sql', base), 'utf8')
  const source = JSON.parse(await readFile(new URL('source.json', base), 'utf8'))
  const mysql = createRequire(import.meta.url)('/www/wwwroot/aurum-ai/node_modules/mysql2/promise.js')
  const credentials = JSON.parse(await readFile(`/proc/self/fd/${process.env.V4_BACKUP_CREDENTIAL_FD}`, 'utf8'))
  connection = await mysql.createConnection({ ...credentials, database: 'dev_vue_m1_a', supportBigNumbers: true, bigNumberStrings: true })
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,VERSION() version')
  check(identity.db === 'dev_vue_m1_a' && identity.uuid === source.identity.uuid, 'rule_probe_identity')
  const [[exists]] = await connection.execute('SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', ['referral_rules'])
  check(Number(exists.n) === 0 && source.ddl.startsWith('CREATE TABLE `referral_rules` ('), 'rule_probe_existing_table')
  await connection.query(source.ddl)
  for (const row of source.rows) await connection.execute('INSERT INTO referral_rules (id,plan,period,rate_bps,enabled) VALUES (?,?,?,?,?)', [row.id,row.plan,row.period,row.rate_bps,row.enabled])
  const readSource = async () => { const [rows] = await connection.query('SELECT CAST(id AS CHAR) id,plan,period,CAST(rate_bps AS CHAR) rate_bps,CAST(enabled AS CHAR) enabled FROM referral_rules ORDER BY referral_rules.id'); return rows.map(row => ({ ...row })) }
  check(JSON.stringify(await readSource()) === JSON.stringify(source.rows), 'rule_probe_source_copy')
  const [[before]] = await connection.query('SHOW CREATE TABLE referral_rules')
  await connection.query(sql)
  const [[after]] = await connection.query('SHOW CREATE TABLE referral_rules')
  check(JSON.stringify(await readSource()) === JSON.stringify(source.rows), 'rule_probe_source_changed')
  const [revisions] = await connection.query('SELECT CAST(revision AS CHAR) revision FROM referral_rules ORDER BY id')
  check(revisions.length === 4 && revisions.every(row => row.revision === '1'), 'rule_probe_revision_initialization')
  await connection.beginTransaction()
  const cases = [ ['negative_rate','rate_bps',-1], ['excess_rate','rate_bps',10001], ['negative_enabled','enabled',-1], ['excess_enabled','enabled',2], ['zero_revision','revision','0'] ]
  const rejected = []
  for (const [name, column, value] of cases) {
    let code = null
    try { await connection.execute(`UPDATE referral_rules SET ${column}=? WHERE id=?`, [value, source.rows[0].id]) } catch (error) { code = error.code }
    check(code === 'ER_CHECK_CONSTRAINT_VIOLATED', 'rule_probe_constraint_missing')
    rejected.push({ name, code })
  }
  for (const rate of [0, 10000]) await connection.execute('UPDATE referral_rules SET rate_bps=?,enabled=0,revision=? WHERE id=?', [rate,'9007199254740993',source.rows[0].id])
  const [[boundary]] = await connection.execute('SELECT rate_bps,enabled,CAST(revision AS CHAR) revision FROM referral_rules WHERE id=?', [source.rows[0].id])
  check(boundary.rate_bps === 10000 && boundary.enabled === 0 && boundary.revision === '9007199254740993', 'rule_probe_boundary')
  await connection.rollback()
  check(JSON.stringify(await readSource()) === JSON.stringify(source.rows), 'rule_probe_rollback')
  const [finalRevisions] = await connection.query('SELECT CAST(revision AS CHAR) revision FROM referral_rules ORDER BY id')
  check(finalRevisions.every(row => row.revision === '1'), 'rule_probe_revision_rollback')
  const report = { kind: 'referral-rule-schema-probe/v1', identity, sourceSqlSha256: sha(sql), sourceRowsSha256: sha(JSON.stringify(source.rows)),
    beforeDdl: before['Create Table'], afterDdl: after['Create Table'], preservedRows: 4, rejectedCases: rejected,
    boundaryAccepted: true, probesRolledBack: true, currentDevVueWritten: false }
  const file = await open(new URL('receipt.json', base), 'wx', 0o600)
  try { await file.writeFile(JSON.stringify(report, null, 2) + '\n'); await file.sync() } finally { await file.close() }
  console.log(JSON.stringify({ status: 'verified', preservedRows: 4, rejectedCases: rejected.length }))
} catch (error) {
  await connection?.rollback().catch(() => {})
  console.error(JSON.stringify({ code: /^rule_probe_[a-z_]+$/.test(error.message) ? error.message : error.code ?? 'rule_probe_failed' })); process.exitCode = 1
} finally { await connection?.end() }
