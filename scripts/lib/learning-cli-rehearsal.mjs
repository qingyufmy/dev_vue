import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readOriginalRows } from './inplace-column-evidence.mjs'
import { canonical, hash } from './v4-backfill-contract.mjs'
import { cleanupLearningRehearsal } from './learning-backfill-rehearsal.mjs'
import { writePrivateJson } from './v4-backup-io.mjs'

const execute = promisify(execFile)
const check = (value, code) => { if (!value) throw Error(code) }

export async function rehearseLearningCli({ pool, root, fixture, directory }) {
  await mkdir(directory, { mode: 0o700 })
  const paths = Object.fromEntries(['basis', 'evidence', 'courses', 'progress'].map(name => [name, join(directory, `${name}.json`)]))
  await writePrivateJson(paths.basis, fixture.reviewedBasis)
  await writePrivateJson(paths.evidence, [...fixture.evidenceCatalog])
  const connection = await pool.getConnection(), commands = []
  try {
    await connection.query("SET SESSION time_zone='+00:00'")
    const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
    check(identity.db === 'dev_vue_m1_source_20260907_02' && identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'learning_cli_rehearsal_scope')
    const [tables] = await connection.query('SELECT TABLE_NAME name,TABLE_TYPE type FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME')
    const descriptors = []
    for (const table of tables) {
      check(table.type === 'BASE TABLE', 'learning_cli_rehearsal_table_type')
      const [columns] = await connection.execute('SELECT COLUMN_NAME name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [table.name])
      const [primary] = await connection.execute("SELECT COLUMN_NAME name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX", [table.name])
      descriptors.push({ name: table.name, columns: columns.map(row => row.name), primary: primary.map(row => row.name) })
    }
    const before = await readOriginalRows(connection, descriptors)
    const command = async (script, args, expected) => {
      const { stdout } = await execute(process.execPath, [fileURLToPath(new URL(`scripts/${script}`, root)), '--rehearsal', ...args],
        { cwd: fileURLToPath(root), timeout: 120000, maxBuffer: 16 * 1024 * 1024, windowsHide: true })
      const result = JSON.parse(stdout)
      check(result.status === expected, 'learning_cli_rehearsal_result')
      commands.push({ script, mode: args[0], status: result.status })
      await writePrivateJson(join(directory, `result-${commands.length}.json`), result)
    }
    await command('prepare-dev-vue-learning.mjs', ['--write', paths.basis, paths.evidence, paths.courses, paths.progress], 'prepared')
    const migrate = async mode => command('migrate-dev-vue-learning.mjs', [`--${mode}`, paths.courses, paths.progress, paths.evidence], mode === 'check' ? 'checked' : 'verified')
    await migrate('check')
    check(canonical(await readOriginalRows(connection, descriptors)) === canonical(before), 'learning_cli_rehearsal_check_wrote')
    await migrate('apply')
    const committed = await readOriginalRows(connection, descriptors)
    for (const mode of ['recover', 'verify', 'apply']) await migrate(mode)
    check(canonical(await readOriginalRows(connection, descriptors)) === canonical(committed), 'learning_cli_rehearsal_repeat_changed')
    await cleanupLearningRehearsal(connection)
    check(canonical(await readOriginalRows(connection, descriptors)) === canonical(before), 'learning_cli_rehearsal_cleanup_changed')
    return { commands, cliEndToEndVerified: true, allTableRowsRestored: true, baselineHash: hash(before), repeatNoop: true }
  } finally { connection.release() }
}
