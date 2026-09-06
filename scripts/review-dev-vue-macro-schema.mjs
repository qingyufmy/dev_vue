import { readFile, writeFile } from 'node:fs/promises'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import { coordinateInplaceSchema } from './lib/inplace-schema-coordinator.mjs'
import { loadMacroSchemaCoordinator } from './lib/inplace-macro-schema.mjs'
import { verifyInplaceJournal, withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { validateColumnEvidence, readOriginalRows, verifyOriginalSchema } from './lib/inplace-column-evidence.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'

const root = new URL('../', import.meta.url)
const json = async path => JSON.parse(await readFile(new URL(path, root), 'utf8'))
let connection
try {
  const [mode] = process.argv.slice(2)
  if (process.argv.length !== 3 || !['--write', '--verify'].includes(mode)) throw new Error('inplace_coordinator_arguments')
  const backup = await json('docs/migration/dev-vue-inplace-backup-20260906.json')
  const columns = await json('docs/migration/dev-vue-inplace-column-rehearsal-20260906.json')
  validateColumnEvidence(backup, columns)
  const plan = await loadMacroSchemaCoordinator(root)
  const env = parse(await readFile(new URL('server/.env', root)))
  if (env.MYSQL_DATABASE !== 'dev_vue') throw new Error('inplace_coordinator_database')
  connection = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: 'dev_vue', timezone: 'Z', dateStrings: true, jsonStrings: true,
    supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false })
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  if (identity.db !== 'dev_vue' || identity.uuid !== backup.serverUuid) throw new Error('inplace_coordinator_instance')
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ')
  const report = await withInplaceUpgradeLock(connection, 'dev_vue', async () => {
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
    try {
      if (!await verifyInplaceJournal(connection)) throw new Error('inplace_coordinator_journal_required')
      const store = plan.store(connection)
      // Defense in depth: the live reviewer has no mutation capability.
      for (const method of ['begin', 'execute', 'complete']) store[method] = async () => { throw new Error('inplace_coordinator_read_only') }
      const result = await coordinateInplaceSchema(store, plan)
      const excluded = [...new Set(plan.steps.filter(step => !step.column).map(step => step.table))]
      await verifyOriginalSchema(connection, backup.schemaSha256, excluded)
      const parity = await readOriginalRows(connection, columns.originalColumns)
      if (JSON.stringify(parity) !== JSON.stringify(columns.parity)) throw new Error('inplace_coordinator_original_changed')
      return { kind: 'inplace-macro-schema-preflight/v1', identity, result,
        steps: plan.steps.map(({ id, checksum }) => ({ id, checksum })),
        originalTables: parity.length, originalRows: parity.reduce((sum, row) => sum + BigInt(row.rows), 0n).toString(),
        originalParityHash: sha256(JSON.stringify(parity)), databaseWrites: 0, fullNormalizationComplete: false }
    } finally { await connection.rollback() }
  })
  const target = new URL('docs/migration/dev-vue-macro-schema-preflight-20260907.json', root)
  if (mode === '--write') await writeFile(target, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  else if (JSON.stringify(JSON.parse(await readFile(target, 'utf8'))) !== JSON.stringify(report)) throw new Error('inplace_coordinator_review_changed')
  console.log(JSON.stringify({ status: 'verified', ...report }))
} catch (error) {
  console.error(JSON.stringify({ code: /^inplace_[a-z_]+$/.test(error.message) ? error.message : 'inplace_coordinator_review_failed' }))
  process.exitCode = 1
} finally { if (connection) await connection.end().catch(() => {}) }
