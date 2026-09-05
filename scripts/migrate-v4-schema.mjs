#!/usr/bin/env node
import mysql from 'mysql2/promise'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadMigrationPlan, V4SchemaMigrationError, requireMigration as check } from './lib/v4-migration-plan.mjs'
import { runSchemaMigrations } from './lib/v4-schema-migration-runner.mjs'
import { loadMigrationCorrections } from './lib/v4-migration-corrections.mjs'

const connections = []
try {
  const args = process.argv.slice(2)
  check(args.every(arg => arg === '--apply' || arg.startsWith('--confirm-target=') || arg.startsWith('--stop-after=') || arg.startsWith('--recover=')), 'migration_argument_invalid')
  check(new Set(args.map(arg => arg.split('=')[0])).size === args.length, 'migration_argument_duplicate')
  const targetDatabase = required('V4_MIGRATION_TARGET_DATABASE')
  const sourceDatabase = required('V4_MIGRATION_SOURCE_DATABASE')
  const apply = args.includes('--apply')
  const confirm = args.find(arg => arg.startsWith('--confirm-target='))?.slice('--confirm-target='.length)
  check(!apply || confirm === targetDatabase, 'migration_target_confirmation_required')
  check(sourceDatabase.toLowerCase() !== targetDatabase.toLowerCase(), 'migration_target_is_source')
  const port = Number(process.env.V4_MIGRATION_TARGET_PORT ?? 3306)
  check(Number.isInteger(port) && port > 0 && port <= 65535, 'migration_port_invalid')
  const config = {
    host: required('V4_MIGRATION_TARGET_HOST'), port, user: required('V4_MIGRATION_TARGET_USER'),
    password: process.env.V4_MIGRATION_TARGET_PASSWORD ?? '', database: targetDatabase,
    multipleStatements: false, connectTimeout: 10000, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true,
  }
  const rootDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const plan = await loadMigrationPlan({ rootDirectory })
  const corrections = await loadMigrationCorrections({ rootDirectory }, plan)
  for (let i = 0; i < 2; i++) connections.push(await mysql.createConnection(config))
  const result = await runSchemaMigrations(connections[0], connections[1], plan, {
    sourceDatabase, targetDatabase, apply, corrections,
    recoveryId: args.find(arg => arg.startsWith('--recover='))?.slice('--recover='.length),
    stopAfterMigration: args.find(arg => arg.startsWith('--stop-after='))?.slice('--stop-after='.length),
  })
  process.stdout.write(`${JSON.stringify({ ...result, targetDatabase, migrationCount: plan.length })}\n`)
} catch (error) {
  process.stderr.write(`${JSON.stringify({ status: 'failed', code: error instanceof V4SchemaMigrationError ? error.code : 'migration_cli_failed',
    details: error instanceof V4SchemaMigrationError ? error.details : {} })}\n`)
  process.exitCode = 1
} finally {
  await Promise.all(connections.map(connection => connection.end().catch(() => undefined)))
}

function required(key) {
  const value = process.env[key]
  check(Boolean(value), 'migration_environment_required', { key })
  return value
}
