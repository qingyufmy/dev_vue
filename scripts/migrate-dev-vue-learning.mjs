import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import mysql from 'mysql2/promise'
import { loadSettingsMigrationEnvironment as loadEnvironment, settingsMigrationConnectionOptions as connectionOptions } from './lib/settings-migration-environment.mjs'
import { learningManifestHash } from './lib/v4-learning-manifest.mjs'
import { requireBackfill as check } from './lib/v4-backfill-contract.mjs'
import { runLearningCommand } from './lib/v4-learning-command.mjs'

const root = new URL('../', import.meta.url)
const json = async path => JSON.parse(await readFile(path, 'utf8'))
let pool
try {
  const [flag, coursePath, progressPath, evidencePath] = process.argv.slice(2)
  if (flag === '--help' && process.argv.length === 3) {
    console.log('node scripts/migrate-dev-vue-learning.mjs --check|--verify|--recover|--apply <course-manifest.json> <progress-manifest.json> <reviewed-evidence.json>')
    console.log('--apply currently permits only the existing restored development copy; dev_vue promotion requires a successful real rehearsal.')
  } else {
    check(process.argv.length === 6 && ['--check', '--verify', '--recover', '--apply'].includes(flag), 'learning_entry_arguments')
    const courseManifest = await json(resolve(coursePath)), progressManifest = await json(resolve(progressPath))
    for (const manifest of [courseManifest, progressManifest]) check(manifest.spec?.bindings?.manifestHash === learningManifestHash(manifest), 'learning_manifest_hash')
    const evidence = await json(resolve(evidencePath))
    check(Array.isArray(evidence) && evidence.length > 0 && evidence.every(row => Array.isArray(row) && row.length === 2), 'learning_entry_evidence')
    const evidenceCatalog = new Map(evidence)
    check(evidenceCatalog.size === evidence.length, 'learning_entry_evidence_duplicate')
    const env = await loadEnvironment(root)
    const backup = await json(new URL('docs/migration/dev-vue-inplace-backup-20260906.json', root))
    pool = mysql.createPool({ ...connectionOptions(env), connectionLimit: 3 })
    const result = await runLearningCommand({ pool, database: env.MYSQL_DATABASE, expectedServerUuid: backup.serverUuid,
      courseManifest, progressManifest, evidenceCatalog, mode: flag.slice(2) })
    console.log(JSON.stringify(result))
    if (['unknown', 'not_committed'].includes(result.status)) process.exitCode = 2
  }
} catch (error) {
  console.error(JSON.stringify({ code: /^(learning|backfill|inplace|settings_environment)_[a-z_]+$/.test(error.message) ? error.message : 'learning_entry_failed' }))
  process.exitCode = 1
} finally { await pool?.end() }
