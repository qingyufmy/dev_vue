import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'
import { loadSettingsMigrationEnvironment, settingsMigrationConnectionOptions } from './lib/settings-migration-environment.mjs'
import { loadColumnConstraintsCoordinator } from './lib/inplace-column-constraints-schema.mjs'
import { coordinateInplaceSchema } from './lib/inplace-schema-coordinator.mjs'
import { withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { defaultNormalizationScope } from './lib/default-normalization-scope.mjs'
import { loadMigrationPlan } from './lib/v4-migration-plan.mjs'
import { plannedColumns } from './lib/v4-upgrade-review.mjs'
import { plannedDefault } from './lib/database-structure-comparison.mjs'

const root = new URL('../', import.meta.url)
let connection, output
try {
  const [mode, destination] = process.argv.slice(2)
  if (mode !== '--read-only' || process.argv.length !== 4 || !isAbsolute(destination)) throw Error('default_review_arguments')
  output = await open(destination, 'wx', 0o600)
  const env = await loadSettingsMigrationEnvironment(root)
  if (env.MYSQL_DATABASE !== 'dev_vue' || env.MYSQL_USER !== 'dev_vue') throw Error('default_review_environment')
  connection = await mysql.createConnection(settingsMigrationConnectionOptions(env))
  await connection.query("SET SESSION time_zone='+00:00'")
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  if (identity.db !== 'dev_vue' || identity.uuid !== 'ac423207-6ef3-11f1-b302-000c29fda104') throw Error('default_review_identity')
  const report = await withInplaceUpgradeLock(connection, 'dev_vue', async () => {
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
    try {
      const plan = await loadColumnConstraintsCoordinator(root)
      if (!(await coordinateInplaceSchema(plan.store(connection), plan)).structureComplete) throw Error('default_review_schema')
      const target = plannedColumns(await loadMigrationPlan({ rootDirectory: fileURLToPath(root) }))
      const definitions = [], fields = []
      for (const [table, columns] of Object.entries(defaultNormalizationScope)) {
        const [[row]] = await connection.query(`SHOW CREATE TABLE \`${table}\``)
        definitions.push({ name: table, definition: row['Create Table'] })
        for (const column of columns) {
          const [[metadata]] = await connection.execute(`SELECT COLUMN_TYPE type,IS_NULLABLE nullable,COLUMN_DEFAULT defaultValue,
            COLLATION_NAME collation,EXTRA extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?`, [table, column])
          const expected = plannedDefault(target[table][column].declaration)
          if (expected.kind !== 'value' || metadata.extra !== '') throw Error('default_review_unsupported')
          fields.push({ table, column, metadata, target: expected.value, targetDeclaration: target[table][column] })
        }
      }
      const [[tokenHash]] = await connection.query(`SELECT CAST(COUNT(*) AS CHAR) total,
        CAST(COALESCE(SUM(CHAR_LENGTH(token_hash)<>64 OR REGEXP_LIKE(token_hash,'[^0-9a-f]','c')),0) AS CHAR) invalid
        FROM bridge_refresh_sessions`)
      const [[tokenDefinition]] = await connection.query('SHOW CREATE TABLE bridge_refresh_sessions')
      const [[tokenMetadata]] = await connection.query("SELECT COLUMN_TYPE type,IS_NULLABLE nullable,COLUMN_DEFAULT defaultValue,COLLATION_NAME collation,EXTRA extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='bridge_refresh_sessions' AND COLUMN_NAME='token_hash'")
      tokenHash.definition = tokenDefinition['Create Table']; tokenHash.metadata = tokenMetadata
      return { kind: 'default-normalization-source/v1', identity, schemaSteps: plan.steps.length, databaseWrites: 0, observedAt: new Date().toISOString(), definitions, fields, tokenHash }
    } finally { await connection.rollback() }
  })
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.sync()
  console.log(JSON.stringify({ fields: report.fields.length, tokenHashes: report.tokenHash.total, invalidTokenHashes: report.tokenHash.invalid }))
} finally { await connection?.end(); await output?.close() }
