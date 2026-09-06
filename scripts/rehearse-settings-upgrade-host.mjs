import { readFile, open } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { executeSettingsUpgrade } from './lib/execute-settings-upgrade.mjs'
const root = new URL('../', import.meta.url)
let connection
try {
  if (process.platform !== 'linux' || process.getuid() !== 0) throw Error('rule_rehearsal_scope')
  const manifest = JSON.parse(await readFile(new URL('../tools.json', root)))
  for (const file of manifest) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(file.path) || file.path.split('/').includes('..') || sha256(await readFile(new URL(file.path, root))) !== file.sha256) throw Error('rule_rehearsal_manifest')
  }
  const mysql = createRequire(import.meta.url)('/www/wwwroot/aurum-ai/node_modules/mysql2/promise.js')
  const credentials = JSON.parse(await readFile(`/proc/self/fd/${process.env.V4_BACKUP_CREDENTIAL_FD}`, 'utf8'))
  connection = await mysql.createConnection({ ...credentials, database: 'dev_vue_m1_source_20260907_02', dateStrings: true,
    jsonStrings: true, supportBigNumbers: true, bigNumberStrings: true, timezone: 'Z' })
  const result = await executeSettingsUpgrade(connection, { database: 'dev_vue_m1_source_20260907_02', apply: true, injectAfterDdl: true })
  const file = await open(new URL('../receipt.json', root), 'wx', 0o600)
  try { await file.writeFile(JSON.stringify({ ...result, toolManifest: manifest, currentDevVueWritten: false }, null, 2) + '\n'); await file.sync() } finally { await file.close() }
  console.log(JSON.stringify({ status: 'verified', ddlCount: result.ddlCount, faultSteps: result.faultSteps, originalRows: result.originalRows }))
} catch (error) {
  console.error(JSON.stringify({ code: error.code ?? (/^rule_/.test(error.message) ? error.message : 'rule_rehearsal_failed') })); process.exitCode = 1
} finally { await connection?.end() }
