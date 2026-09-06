import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { executeNullMembershipWave } from './lib/execute-null-membership-wave.mjs'
import { hash } from './lib/v4-backfill-contract.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { writePrivateJson } from './lib/v4-backup-io.mjs'
const root = new URL('../', import.meta.url)
let c, pool
try {
  if (process.platform !== 'linux' || process.getuid() !== 0) throw new Error('null_membership_host_scope')
  const toolManifest = JSON.parse(await readFile(new URL('../tools.json', root), 'utf8'))
  for (const file of toolManifest) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(file.path) || file.path.split('/').includes('..')
      || sha256(await readFile(new URL(file.path, root))) !== file.sha256) throw new Error('null_membership_host_manifest')
  }
  const credentials = JSON.parse(await readFile(`/proc/self/fd/${process.env.V4_BACKUP_CREDENTIAL_FD}`, 'utf8'))
  const mysql = createRequire(import.meta.url)('/www/wwwroot/aurum-ai/node_modules/mysql2/promise.js')
  const database = 'dev_vue_m1_source_20260907_02'
  pool = mysql.createPool({ ...credentials, database, timezone: 'Z', dateStrings: true, jsonStrings: true,
    supportBigNumbers: true, bigNumberStrings: true, connectionLimit: 3 })
  c = await pool.getConnection()
  let loseCommit = false
  const wrapped = new WeakSet()
  const faultPool = { async getConnection() {
    const connection = await pool.getConnection()
    if (!wrapped.has(connection)) {
      wrapped.add(connection)
      const commit = connection.commit.bind(connection)
      connection.commit = async () => { await commit(); if (loseCommit) { loseCommit = false; connection.destroy(); throw new Error('response_lost') } }
    }
    return connection
  } }
  const run = { id: 'ffffffff-ffff-4fff-8fff-ffffffffff04', sourceSnapshotId: 'dev-vue-null-memberships-20260907', registeredAtUtc: new Date().toISOString() }
  const options = { database, run, manifestHash: hash(toolManifest), apply: true }
  const result = await executeNullMembershipWave(c, faultPool, { ...options, beforeBatch: index => { if (index === 0) loseCommit = true } })
  if (result.recovered.length !== 1) throw new Error('null_membership_host_recovery')
  const repeated = await executeNullMembershipWave(c, faultPool, options)
  await writePrivateJson(new URL('../receipt.json', root).pathname, { kind: 'null-membership-wave-rehearsal/v1', result, repeated, toolManifest,
    currentDevVueWritten: false, retainedMembershipRows: 21 })
  console.log(JSON.stringify({ status: 'verified', rows: result.selectedRows, recovered: result.recovered.length, repeatNoop: repeated.repeatNoop }))
} catch (error) {
  console.error(JSON.stringify({ code: error.code ?? (/^null_membership_/.test(error.message) ? error.message : 'null_membership_host_failed') })); process.exitCode = 1
} finally { c?.release(); await pool?.end() }
