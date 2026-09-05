#!/usr/bin/env node
import mysql from 'mysql2/promise'
import { evaluateV4MigrationTarget, V4MigrationTargetPreflightError } from './lib/v4-migration-target-preflight.mjs'

const mode = argument('--mode') ?? 'empty'
const targetDatabase = required('V4_MIGRATION_TARGET_DATABASE')
const sourceDatabase = required('V4_MIGRATION_SOURCE_DATABASE')
if (targetDatabase === sourceDatabase) fail('v4_migration_target_is_source')

let connection
try {
  connection = await mysql.createConnection({
    host: required('V4_MIGRATION_TARGET_HOST'),
    port: integerEnvironment('V4_MIGRATION_TARGET_PORT', 3306),
    user: required('V4_MIGRATION_TARGET_USER'),
    password: process.env.V4_MIGRATION_TARGET_PASSWORD ?? '',
    database: targetDatabase,
  })
  await connection.query('START TRANSACTION READ ONLY')
  const [[databaseRow]] = await connection.query('SELECT DATABASE() AS current_database')
  const [tableRows] = await connection.query('SELECT TABLE_NAME AS table_name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME')
  const [columnRows] = await connection.query("SELECT TABLE_NAME AS table_name,COLUMN_NAME AS column_name,COLUMN_TYPE AS column_type FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='inference_snapshots' ORDER BY ORDINAL_POSITION")
  const tables = tableRows.map(row => String(row.table_name))
  let migrationIds = []
  if (tables.includes('schema_migrations')) {
    const [migrationRows] = await connection.query('SELECT id FROM schema_migrations ORDER BY id')
    migrationIds = migrationRows.map(row => String(row.id))
  }
  const result = evaluateV4MigrationTarget({
    currentDatabase: String(databaseRow.current_database ?? ''), sourceDatabase, tables, migrationIds,
    columns: { inference_snapshots: columnRows.map(row => ({ name: row.column_name, type: row.column_type })) },
  }, mode)
  await connection.rollback()
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} catch (error) {
  if (connection) await connection.rollback().catch(() => undefined)
  if (error instanceof V4MigrationTargetPreflightError) fail(error.code, error.details)
  fail('v4_migration_target_preflight_failed', { message: error instanceof Error ? error.message : 'unknown_error' }, 2)
} finally {
  if (connection) await connection.end().catch(() => undefined)
}

function argument(name) {
  const prefix = `${name}=`
  const value = process.argv.slice(2).find(item => item.startsWith(prefix))
  return value ? value.slice(prefix.length) : null
}

function required(name) {
  const value = process.env[name]
  if (!value) fail(`${name}_required`, {}, 2)
  return value
}

function integerEnvironment(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) fail(`${name}_invalid`, {}, 2)
  return value
}

function fail(code, details = {}, exitCode = 1) {
  process.stderr.write(`${JSON.stringify({ status: 'fail', code, details })}\n`)
  process.exit(exitCode)
}
