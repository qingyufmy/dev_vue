import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { loadSettingsMigrationEnvironment, settingsMigrationConnectionOptions } from './lib/settings-migration-environment.mjs'
import { loadSubscriptionForeignKeyCoordinator } from './lib/inplace-subscription-foreign-key-schema.mjs'
import { coordinateInplaceSchema } from './lib/inplace-schema-coordinator.mjs'
import { withInplaceUpgradeLock, verifyInplaceJournal } from './lib/mysql-inplace-column-store.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'

const root = new URL('../', import.meta.url)
const check = (value, code) => { if (!value) throw Error(`relation_review_${code}`) }
const quote = value => { check(/^[a-z][a-z0-9_]*$/.test(value), 'identifier'); return `\`${value}\`` }
let connection, output
try {
  const [mode, destination] = process.argv.slice(2)
  check(mode === '--read-only' && process.argv.length === 4 && isAbsolute(destination), 'arguments')
  output = await open(destination, 'wx', 0o600)
  const env = await loadSettingsMigrationEnvironment(root)
  check(env.MYSQL_DATABASE === 'dev_vue' && env.MYSQL_USER === 'dev_vue', 'scope')
  connection = await mysql.createConnection(settingsMigrationConnectionOptions(env))
  await connection.query("SET SESSION time_zone='+00:00'")
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,@@session.foreign_key_checks foreign_key_checks')
  check(identity.db === 'dev_vue' && identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'identity')
  check(Number(identity.foreign_key_checks) === 1, 'foreign_keys_disabled')
  const report = await withInplaceUpgradeLock(connection, identity.db, async () => {
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
    try {
      check(await verifyInplaceJournal(connection), 'journal')
      const plan = await loadSubscriptionForeignKeyCoordinator(root)
      check((await coordinateInplaceSchema(plan.store(connection), plan)).structureComplete, 'schema')
      const metadata = async () => {
        const [keys] = await connection.query(`SELECT k.TABLE_NAME table_name,k.CONSTRAINT_NAME constraint_name,k.COLUMN_NAME column_name,
          k.REFERENCED_TABLE_NAME parent,k.REFERENCED_COLUMN_NAME parent_column,k.ORDINAL_POSITION ordinal_position,
          r.UPDATE_RULE update_rule,r.DELETE_RULE delete_rule FROM information_schema.KEY_COLUMN_USAGE k
          JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA=k.CONSTRAINT_SCHEMA AND r.TABLE_NAME=k.TABLE_NAME AND r.CONSTRAINT_NAME=k.CONSTRAINT_NAME
          WHERE k.TABLE_SCHEMA=DATABASE() ORDER BY k.TABLE_NAME,k.CONSTRAINT_NAME,k.ORDINAL_POSITION`)
        const [checks] = await connection.query(`SELECT t.TABLE_NAME table_name,t.CONSTRAINT_NAME constraint_name,c.CHECK_CLAUSE clause,t.ENFORCED enforced
          FROM information_schema.TABLE_CONSTRAINTS t JOIN information_schema.CHECK_CONSTRAINTS c
          ON c.CONSTRAINT_SCHEMA=t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME=t.CONSTRAINT_NAME
          WHERE t.TABLE_SCHEMA=DATABASE() ORDER BY t.TABLE_NAME,t.CONSTRAINT_NAME`)
        return { keys, checks }
      }
      const first = await metadata(), groups = new Map(), foreignKeys = [], checks = [], definitions = new Map()
      for (const key of first.keys) {
        const id = key.table_name + '/' + key.constraint_name
        if (!groups.has(id)) groups.set(id, [])
        groups.get(id).push(key)
      }
      for (const columns of groups.values()) {
        const head = columns[0]
        check(columns.every((row, i) => row.ordinal_position === i + 1 && row.parent === head.parent), 'foreign_key_metadata')
        const nonNull = columns.map(row => `c.${quote(row.column_name)} IS NOT NULL`).join(' AND ')
        const match = columns.map(row => `p.${quote(row.parent_column)}=c.${quote(row.column_name)}`).join(' AND ')
        const [[result]] = await connection.query(`SELECT COUNT(*) orphan_count FROM ${quote(head.table_name)} c WHERE ${nonNull}
          AND NOT EXISTS (SELECT 1 FROM ${quote(head.parent)} p WHERE ${match})`)
        foreignKeys.push({ table: head.table_name, name: head.constraint_name, parent: head.parent,
          columns: columns.map(row => row.column_name), parentColumns: columns.map(row => row.parent_column),
          updateRule: head.update_rule, deleteRule: head.delete_rule, orphanCount: String(result.orphan_count) })
      }
      for (const row of first.checks) {
        if (!definitions.has(row.table_name)) {
          const [[definition]] = await connection.query(`SHOW CREATE TABLE ${quote(row.table_name)}`)
          definitions.set(row.table_name, definition['Create Table'])
        }
        // CHECK_CLAUSE escapes quotes for metadata display. SHOW CREATE retains
        // executable SQL literals; never broadly unescape a stored expression.
        const lines = definitions.get(row.table_name).split('\n').filter(line => line.startsWith(`  CONSTRAINT ${quote(row.constraint_name)} CHECK `))
        check(lines.length === 1, 'check_definition')
        const expression = / CHECK (\(.+\))(?: \/\*!\d+ NOT ENFORCED \*\/)?[,]?$/.exec(lines[0])?.[1]
        check(expression && !/;|--|\/\*|\*\//.test(expression), 'check_expression')
        const [[result]] = await connection.query(`SELECT COUNT(*) violation_count FROM ${quote(row.table_name)} WHERE NOT (${expression})`)
        checks.push({ table: row.table_name, name: row.constraint_name, clause: row.clause, expression, enforced: row.enforced, violationCount: String(result.violation_count) })
      }
      check(JSON.stringify(first) === JSON.stringify(await metadata()), 'metadata_changed')
      return { kind: 'current-relation-data-review/v1', identity, observedAt: new Date().toISOString(), schemaSteps: plan.steps.length,
        databaseWrites: 0, consistentReadOnlyTransaction: true, metadataSha256: sha256(JSON.stringify(first)),
        summary: { foreignKeys: foreignKeys.length, checks: checks.length, orphanGroups: foreignKeys.filter(row => row.orphanCount !== '0').length,
          checkViolationGroups: checks.filter(row => row.violationCount !== '0').length, disabledChecks: checks.filter(row => row.enforced !== 'YES').length },
        foreignKeys, checks }
    } finally { await connection.rollback() }
  })
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.sync()
  console.log(JSON.stringify(report.summary))
} catch (error) {
  const failure = { verified: false, code: /^relation_review_[a-z_]+$/.test(error.message) ? error.message : 'relation_review_failed', mysqlCode: error.code }
  if (output) { await output.writeFile(JSON.stringify(failure) + '\n'); await output.sync() }
  console.log(JSON.stringify(failure)); process.exitCode = 1
} finally { await connection?.end(); await output?.close() }
