import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { validateColumnEvidence } from './lib/inplace-column-evidence.mjs'
import { writePrivateJson } from './lib/v4-backup-io.mjs'
import { rehearseLearningBackfill } from './lib/learning-backfill-rehearsal.mjs'

const root = new URL('../', import.meta.url), base = '/www/backup/aurum-v4/m1/20260906-01'
const database = 'dev_vue_m1_source_20260907_02'
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const check = (condition, code) => { if (!condition) throw Error(code) }
let pool
try {
  check(process.platform === 'linux' && process.getuid() === 0, 'learning_rehearsal_host_scope')
  const manifest = await json(new URL('../tools.json', root))
  for (const file of manifest) {
    check(/^[a-zA-Z0-9_./-]+$/.test(file.path) && !file.path.split('/').includes('..')
      && sha256(await readFile(new URL(file.path, root))) === file.sha256, 'learning_rehearsal_tools')
  }
  const backup = await json(`${base}/artifacts/receipt.json`), columns = await json(`${base}/column-rehearsal/receipt.json`)
  validateColumnEvidence(backup, columns)
  const credentials = await json(`/proc/self/fd/${process.env.V4_BACKUP_CREDENTIAL_FD}`)
  const mysql = createRequire(import.meta.url)('/www/wwwroot/aurum-ai/node_modules/mysql2/promise.js')
  pool = mysql.createPool({ ...credentials, database, dateStrings: true, jsonStrings: true, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true, connectionLimit: 3 })
  const report = await rehearseLearningBackfill({ pool, root, backup, columns, manifest })
  await writePrivateJson(new URL('../receipt.json', root).pathname, report)
  console.log(JSON.stringify({ status: 'verified', courseRows: report.courseAudit.sourceRows, progressRows: report.progressAudit.sourceRows, fixtureCleanup: true }))
} catch (error) {
  console.error(JSON.stringify({ code: /^(learning|backfill|inplace)_[a-z_]+$/.test(error.message) ? error.message : 'learning_rehearsal_failed' })); process.exitCode = 1
} finally { await pool?.end() }
