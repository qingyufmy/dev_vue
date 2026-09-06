import { readFile, open } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import { executeNullMembershipWave } from './lib/execute-null-membership-wave.mjs'
import { hash } from './lib/v4-backfill-contract.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'
const root = new URL('../', import.meta.url)
const check = (ok, code) => { if (!ok) throw new Error(code) }
let c, pool, receipt
try {
  const [mode] = process.argv.slice(2)
  check(process.argv.length === 3 && ['--plan', '--apply'].includes(mode), 'null_membership_arguments')
  const proofBytes = await readFile(new URL('docs/migration/dev-vue-null-membership-rehearsal-20260907.json', root))
  check(sha256(proofBytes) === '975fe17f3eead5141a5a1cf2848321fc826be048bc28693830793e565dc8bc6e', 'null_membership_proof_changed')
  const proof = JSON.parse(proofBytes)
  check(proof.kind === 'null-membership-wave-rehearsal/v1' && proof.result.selectedRows === 21 && proof.result.recovered.length === 1
    && proof.repeated.repeatNoop && proof.repeated.audit.importMatchesReviewedInputs, 'null_membership_proof_invalid')
  for (const file of proof.toolManifest) {
    check(/^[a-zA-Z0-9_./-]+$/.test(file.path) && !file.path.split('/').includes('..')
      && sha256(await readFile(new URL(file.path, root))) === file.sha256, 'null_membership_tools_changed')
  }
  const review = JSON.parse(await readFile(new URL('docs/migration/dev-vue-null-membership-review-20260907.json', root), 'utf8'))
  check(sha256(await readFile(review.referencePath)) === review.referenceSha256
    && sha256(await readFile(new URL('server/src/modules/commerce/domain/membership.ts', root))) === review.normalizedDomainSourceSha256
    && sha256(await readFile(new URL('server/dist-v4/modules/commerce/domain/membership.js', root))) === review.normalizedDomainBuildSha256, 'null_membership_policy_code_changed')
  const env = parse(await readFile(new URL('server/.env', root)))
  check(env.MYSQL_DATABASE === 'dev_vue', 'null_membership_env_scope')
  const runPath = new URL('docs/migration/dev-vue-null-membership-run-20260907.json', root)
  let run
  try { run = JSON.parse(await readFile(runPath, 'utf8')) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    run = { id: randomUUID(), sourceSnapshotId: 'dev-vue-null-memberships-20260907', registeredAtUtc: new Date().toISOString() }
    if (mode === '--apply') {
      const file = await open(runPath, 'wx', 0o600)
      try { await file.writeFile(JSON.stringify(run, null, 2) + '\n'); await file.sync() } finally { await file.close() }
    }
  }
  const receiptPath = `docs/migration/dev-vue-null-membership-apply-${randomUUID()}.json`
  if (mode === '--apply') receipt = await open(new URL(receiptPath, root), 'wx', 0o600)
  pool = mysql.createPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER, password: env.MYSQL_PASSWORD,
    database: 'dev_vue', dateStrings: true, jsonStrings: true, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true, connectionLimit: 3 })
  c = await pool.getConnection()
  const result = await executeNullMembershipWave(c, pool, { database: 'dev_vue', run, manifestHash: hash(proof.toolManifest), apply: mode === '--apply' })
  if (receipt) { await receipt.writeFile(JSON.stringify({ ...result, rehearsalSha256: sha256(proofBytes), driverSha256: sha256(await readFile(new URL(import.meta.url))) }, null, 2) + '\n'); await receipt.sync() }
  console.log(JSON.stringify({ status: result.status, selectedRows: result.selectedRows, deferredRows: result.deferredRows,
    batchSizes: result.batchSizes, originalRows: result.originalRows, repeatNoop: result.repeatNoop, ...(receipt ? { receiptPath } : {}) }))
} catch (error) {
  const failure = { status: 'failed', code: error.code ?? (/^null_membership_/.test(error.message) ? error.message : 'null_membership_apply_failed') }
  if (receipt) { await receipt.writeFile(JSON.stringify(failure) + '\n'); await receipt.sync() }
  console.error(JSON.stringify(failure)); process.exitCode = 1
} finally { await receipt?.close(); c?.release(); await pool?.end() }
