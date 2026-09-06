import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { auditReferralLedger } from './lib/v4-referral-ledger-audit.mjs'
import { createReferralBackfill } from './lib/v4-referral-backfill-writer.mjs'
import { readReferralTargetIdentity } from './lib/mysql-referral-backfill.mjs'
import { canonical, hash } from './lib/v4-backfill-contract.mjs'

const base = '/www/backup/aurum-v4/m1/20260906-01/referral-backfill-03'
const json = async path => JSON.parse(await readFile(path, 'utf8'))
let connection
try {
  const run = await json(`${base}/run.json`), proof = await json(`${base}/receipt.json`)
  if (hash(run) !== proof.runManifestHash) throw new Error('referral_audit_run_changed')
  const mysql = createRequire(import.meta.url)('/www/wwwroot/aurum-ai/node_modules/mysql2/promise.js')
  const credentials = await json(`/proc/self/fd/${process.env.V4_BACKUP_CREDENTIAL_FD}`)
  connection = await mysql.createConnection({ ...credentials, database: 'dev_vue_m1_source_20260907_02', timezone: 'Z',
    dateStrings: true, jsonStrings: true, supportBigNumbers: true, bigNumberStrings: true })
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  const identity = await readReferralTargetIdentity(connection)
  if (canonical(identity) !== canonical(proof.identity)) throw new Error('referral_audit_identity_changed')
  const [data] = await connection.query('SELECT CAST(id AS CHAR) id,referral_code,referred_by,referral_credit,created_at,updated_at FROM users ORDER BY users.id')
  const prepared = createReferralBackfill(data.map(row => ({ ...row })), run.registeredAtUtc, { batchSize: run.bindingManifest.batchSize })
  if (prepared.sourceHash !== run.bindingManifest.sourceHash) throw new Error('referral_audit_source_changed')
  const audit = await auditReferralLedger(connection, run.spec, prepared)
  await connection.rollback()
  const toolManifest = []
  for (const file of ['audit-referral-backfill-host.mjs', 'lib/v4-referral-ledger-audit.mjs']) {
    toolManifest.push({ path: `scripts/${file}`, sha256: createHash('sha256').update(await readFile(new URL(file, import.meta.url))).digest('hex') })
  }
  console.log(JSON.stringify({ kind: 'referral-backfill-ledger-audit/v1', identity, runManifestHash: hash(run),
    sourceHash: prepared.sourceHash, audit, toolManifest, databaseWrites: 0 }))
} catch (error) {
  console.error(JSON.stringify({ code: /^referral_[a-z_]+$/.test(error.message) ? error.message : 'referral_audit_failed' })); process.exitCode = 1
} finally { await connection?.end() }
