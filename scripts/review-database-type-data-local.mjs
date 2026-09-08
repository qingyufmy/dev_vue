import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { loadSettingsMigrationEnvironment, settingsMigrationConnectionOptions } from './lib/settings-migration-environment.mjs'
import { loadModelCheckCoordinator } from './lib/inplace-model-check-schema.mjs'
import { coordinateInplaceSchema } from './lib/inplace-schema-coordinator.mjs'
import { withInplaceUpgradeLock, verifyInplaceJournal } from './lib/mysql-inplace-column-store.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'

const root = new URL('../', import.meta.url)
const check = (condition, code) => { if (!condition) throw Error(`type_data_review_${code}`) }
const quote = value => { check(/^[a-z][a-z0-9_]*$/.test(value), 'identifier'); return `\`${value}\`` }
let output, connection
try {
  const [mode, inventoryPath, destination] = process.argv.slice(2)
  check(mode === '--read-only' && process.argv.length === 5 && isAbsolute(inventoryPath) && isAbsolute(destination), 'arguments')
  output = await open(destination, 'wx', 0o600)
  const env = await loadSettingsMigrationEnvironment(root)
  check(env.MYSQL_DATABASE === 'dev_vue' && env.MYSQL_USER === 'dev_vue', 'environment')
  connection = await mysql.createConnection({ ...settingsMigrationConnectionOptions(env), connectTimeout: 5000 })
  await connection.query("SET SESSION time_zone='+00:00'")
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,@@session.sql_mode sql_mode')
  check(identity.db === 'dev_vue' && identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'identity')
  const bytes = await readFile(inventoryPath)
  const inventory = JSON.parse(bytes)
  check(inventory.kind === 'database-structure-remaining-work/v1' && Array.isArray(inventory.typeDifferences)
    && inventory.identity.database_name === identity.db && inventory.identity.server_uuid === identity.uuid, 'inventory')
  const candidates = [...new Map([...inventory.typeDifferences, ...(inventory.nullabilityDifferences ?? [])]
    .map(field => [`${field.table}.${field.column}`, field])).values()]
  const result = await withInplaceUpgradeLock(connection, identity.db, async () => {
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
    try {
      check(await verifyInplaceJournal(connection), 'journal')
      const plan = await loadModelCheckCoordinator(root)
      check(JSON.stringify(inventory.schemaSteps) === JSON.stringify(plan.steps.map(row => ({ id: row.id, status: 'completed' }))), 'inventory_version')
      check((await coordinateInplaceSchema(plan.store(connection), plan)).structureComplete, 'schema')
      const tables = [], fields = []
      for (const name of [...new Set(candidates.map(row => row.table))]) {
        const [[definition]] = await connection.query(`SHOW CREATE TABLE ${quote(name)}`)
        tables.push({ name, definition: definition['Create Table'], sha256: sha256(definition['Create Table']) })
      }
      for (const field of candidates) {
        const [metadata] = await connection.execute(`SELECT COLUMN_TYPE type,IS_NULLABLE nullable,COLUMN_DEFAULT defaultValue,EXTRA extra,
          COLLATION_NAME collation,DATETIME_PRECISION datetime_precision FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?`, [field.table, field.column])
        check(metadata.length === 1 && metadata[0].type === field.actualType, 'column_drift')
        const column = quote(field.column), table = quote(field.table)
        const parts = ['CAST(COUNT(*) AS CHAR) row_count', `CAST(COALESCE(SUM(${column} IS NULL),0) AS CHAR) null_count`]
        let category
        if (/^datetime(?:\(\d+\))?$/.test(field.actualType)) {
          category = 'datetime_precision'
          parts.push(`CAST(COALESCE(SUM(${column} IS NOT NULL AND (YEAR(${column})=0 OR MONTH(${column})=0 OR DAYOFMONTH(${column})=0)),0) AS CHAR) incomplete_dates`,
            `CAST(MIN(${column}) AS CHAR) min_value`, `CAST(MAX(${column}) AS CHAR) max_value`)
        } else if (/^(?:tinyint|smallint|mediumint|int|bigint|decimal)(?:\(|\s|$)/.test(field.actualType)) {
          category = 'numeric_range'
          parts.push(`CAST(COALESCE(SUM(${column}<0),0) AS CHAR) negative_count`, `CAST(MIN(${column}) AS CHAR) min_value`, `CAST(MAX(${column}) AS CHAR) max_value`)
        } else if (/^(?:varchar|char)\(/.test(field.actualType)) {
          category = 'text_capacity_or_semantics'
          parts.push(`CAST(MAX(CHAR_LENGTH(${column})) AS CHAR) max_characters`, `CAST(MAX(OCTET_LENGTH(${column})) AS CHAR) max_bytes`)
        } else throw Error('type_data_review_unsupported')
        const sql = `SELECT ${parts.join(',')} FROM ${table}`
        const [[first]] = await connection.query(sql), [[second]] = await connection.query(sql)
        check(JSON.stringify(first) === JSON.stringify(second), 'data_changed')
        const [relations] = await connection.execute(`SELECT TABLE_NAME table_name,COLUMN_NAME column_name,CONSTRAINT_NAME constraint_name,
          REFERENCED_TABLE_NAME parent_table,REFERENCED_COLUMN_NAME parent_column FROM information_schema.KEY_COLUMN_USAGE
          WHERE CONSTRAINT_SCHEMA=DATABASE() AND ((TABLE_NAME=? AND COLUMN_NAME=?) OR (REFERENCED_TABLE_NAME=? AND REFERENCED_COLUMN_NAME=?))
          ORDER BY TABLE_NAME,CONSTRAINT_NAME,ORDINAL_POSITION`, [field.table, field.column, field.table, field.column])
        fields.push({ ...field, category, metadata: metadata[0], data: first, relations })
      }
      return { kind: 'database-type-data-review/v1', observedAt: new Date().toISOString(), identity,
        inventorySha256: sha256(bytes), schemaSteps: plan.steps.length, databaseWrites: 0, tables, fields,
        summary: { reviewedFields: fields.length, datetimeFields: fields.filter(row => row.category === 'datetime_precision').length,
          negativeNumericFields: fields.filter(row => row.data.negative_count && row.data.negative_count !== '0').map(row => `${row.table}.${row.column}`),
          incompleteDateFields: fields.filter(row => row.data.incomplete_dates && row.data.incomplete_dates !== '0').map(row => `${row.table}.${row.column}`) },
        scope: 'Read-only ranges, nullability, defaults and FK references. Does not approve root ID remapping or state/ownership semantics.' }
    } finally { await connection.rollback() }
  })
  await output.writeFile(JSON.stringify(result, null, 2) + '\n'); await output.sync()
  console.log(JSON.stringify(result.summary))
} catch (error) {
  console.error(JSON.stringify({ code: /^type_data_review_[a-z_]+$/.test(error.message) ? error.message : 'type_data_review_failed' }))
  process.exitCode = 1
} finally { await connection?.end(); await output?.close() }
