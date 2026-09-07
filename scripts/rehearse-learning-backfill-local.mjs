import { readFile, readdir, open } from 'node:fs/promises'
import { resolve, relative, isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'
import { loadSettingsMigrationEnvironment, settingsMigrationConnectionOptions } from './lib/settings-migration-environment.mjs'
import { rehearseLearningBackfill } from './lib/learning-backfill-rehearsal.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { loadLearningHistoricalSchema } from './lib/learning-restored-schema.mjs'
import { rehearseLearningCli } from './lib/learning-cli-rehearsal.mjs'

const root = new URL('../', import.meta.url)
const database = 'dev_vue_m1_source_20260907_02'
const check = (value, code) => { if (!value) throw Error(code) }
const json = async path => JSON.parse(await readFile(path, 'utf8'))
let pool, receipt
try {
  const [flag, destination, historicalSql] = process.argv.slice(2)
  if (flag === '--help' && process.argv.length === 3) {
    console.log('node scripts/rehearse-learning-backfill-local.mjs --apply <private-receipt.json> <verified-historical-backup.sql>')
    console.log('Runs locally against the fixed restored MySQL database using server/.env credentials. Synthetic time evidence is fixture-only.')
  } else {
    check(flag === '--apply' && process.argv.length === 5 && isAbsolute(destination) && isAbsolute(historicalSql), 'learning_rehearsal_arguments')
    const location = relative(fileURLToPath(root), resolve(destination))
    check(location.startsWith(`..${sep}`) || isAbsolute(location), 'learning_rehearsal_private_receipt')
    receipt = await open(resolve(destination), 'wx', 0o600)
    const manifest = []
    for (const directory of ['scripts', 'server/db/migrations']) {
      const files = await readdir(new URL(`${directory}/`, root), { recursive: true, withFileTypes: true })
      for (const file of files.filter(file => file.isFile() && /\.(mjs|sql)$/.test(file.name))) {
        const absolute = resolve(file.parentPath, file.name)
        manifest.push({ path: relative(fileURLToPath(root), absolute).replaceAll('\\', '/'), sha256: sha256(await readFile(absolute)) })
      }
    }
    manifest.sort((a, b) => a.path.localeCompare(b.path))
    const backup = await json(new URL('docs/migration/dev-vue-inplace-backup-20260906.json', root))
    const columns = await json(new URL('docs/migration/dev-vue-inplace-column-rehearsal-20260906.json', root))
    const historicalDefinitions = await loadLearningHistoricalSchema(historicalSql, backup)
    const env = await loadSettingsMigrationEnvironment(root)
    pool = mysql.createPool({ ...settingsMigrationConnectionOptions(env), database, jsonStrings: true, connectionLimit: 3 })
    let fixture
    const report = await rehearseLearningBackfill({ pool, root, backup, columns, manifest, historicalDefinitions,
      onFixture: async value => { fixture = value } })
    const cli = await rehearseLearningCli({ pool, root, fixture, directory: `${resolve(destination)}.cli` })
    for (const file of manifest) check(sha256(await readFile(new URL(file.path, root))) === file.sha256, 'learning_rehearsal_tools_changed')
    await receipt.writeFile(JSON.stringify({ ...report, cli, cliEndToEndVerified: true, executionHost: 'local', completedAtUtc: new Date().toISOString() }, null, 2) + '\n')
    await receipt.sync()
    console.log(JSON.stringify({ status: 'verified', database, courseRows: report.courseAudit.sourceRows,
      progressRows: report.progressAudit.sourceRows, fixtureCleanup: report.fixtureCleanupVerified, cliEndToEndVerified: true, executionHost: 'local' }))
  }
} catch (error) {
  console.error(JSON.stringify({ code: /^(learning|backfill|inplace|settings_environment)_[a-z_]+$/.test(error.message)
    ? error.message : 'learning_rehearsal_failed' }))
  process.exitCode = 1
} finally { await receipt?.close(); await pool?.end() }
