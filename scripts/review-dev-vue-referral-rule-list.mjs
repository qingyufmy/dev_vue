import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import { listAdminReferralRules } from '../server/dist-v4/modules/commerce/infrastructure/mysql-referral-rule-list.js'
const root = new URL('../', import.meta.url)
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const check = (ok, code) => { if (!ok) throw Error(code) }
let pool, c
try {
  const mode = process.argv[2]
  check(process.argv.length === 3 && ['--write', '--verify'].includes(mode), 'rule_list_review_arguments')
  const env = parse(await readFile(new URL('server/.env', root)))
  check(env.MYSQL_DATABASE === 'dev_vue', 'rule_list_review_scope')
  pool = mysql.createPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER, password: env.MYSQL_PASSWORD,
    database: 'dev_vue', supportBigNumbers: true, bigNumberStrings: true, connectionLimit: 2 })
  c = await pool.getConnection()
  const [[identity]] = await c.query('SELECT DATABASE() db,@@server_uuid uuid')
  check(identity.db === 'dev_vue' && identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'rule_list_review_identity')
  const [[actor]] = await c.query("SELECT id FROM users WHERE role='admin' AND deletion_status='active' AND deleted_at IS NULL ORDER BY id LIMIT 1")
  check(actor, 'rule_list_review_admin_missing')
  const read = async () => { const [rows] = await c.query('SELECT CAST(id AS CHAR) id,plan,period,CAST(rate_bps AS CHAR) rate_bps,CAST(enabled AS CHAR) enabled,CAST(revision AS CHAR) revision FROM referral_rules ORDER BY referral_rules.id'); return rows.map(row => ({ ...row })) }
  const before = await read()
  const result = await listAdminReferralRules(pool, Number(actor.id))
  check(JSON.stringify(await read()) === JSON.stringify(before), 'rule_list_review_source_changed')
  check(JSON.stringify(result) === JSON.stringify(before.map(row => ({ id: row.id, plan: row.plan, period: row.period, rateBps: Number(row.rate_bps), enabled: row.enabled === '1', revision: row.revision }))), 'rule_list_review_mismatch')
  const old = JSON.parse(await readFile(new URL('docs/migration/dev-vue-referral-rule-source-review-20260907.json', root)))
  check(JSON.stringify(before.map(({ revision, ...row }) => row)) === JSON.stringify(old.result.entries.map(entry => entry.source)), 'rule_list_review_legacy_changed')
  const sourceFiles = []
  for (const path of ['server/src/modules/commerce/infrastructure/mysql-referral-rule-list.ts', 'server/dist-v4/modules/commerce/infrastructure/mysql-referral-rule-list.js']) sourceFiles.push({ path, sha256: sha(await readFile(new URL(path, root))) })
  const report = { kind: 'referral-rule-list-review/v1', identity, rows: result.length, result,
    sourceSha256: sha(JSON.stringify(before)), sourceFiles, legacyFieldsMatched: true, databaseWritten: false, httpSessionVerified: false }
  const target = new URL('docs/migration/dev-vue-referral-rule-list-review-20260907.json', root)
  if (mode === '--write') await writeFile(target, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  else check(JSON.stringify(JSON.parse(await readFile(target))) === JSON.stringify(report), 'rule_list_review_drift')
  console.log(JSON.stringify({ status: 'verified', rows: result.length, legacyFieldsMatched: true, databaseWritten: false }))
} catch (error) {
  console.error(JSON.stringify({ code: /^rule_list_review_/.test(error.message) ? error.message : 'rule_list_review_failed' })); process.exitCode = 1
} finally { c?.release(); await pool?.end() }
