import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import { prepareCurrentAccountWave } from './lib/current-account-wave-preparation.mjs'

const root = new URL('../', import.meta.url)
let connection
try {
  const [mode, destination] = process.argv.slice(2)
  assert.ok(mode === '--read-only' && isAbsolute(destination ?? '') && process.argv.length === 4)
  const env = parse(await readFile(new URL('server/.env', root)))
  assert.equal(env.MYSQL_DATABASE, 'dev_vue')
  connection = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: 'dev_vue', timezone: 'Z', dateStrings: true, jsonStrings: true,
    supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false, connectTimeout: 5000 })
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  const prepared = await prepareCurrentAccountWave(connection, root)
  await connection.rollback()
  const result = { observedAt: new Date().toISOString(), ...prepared, databaseWrites: 0,
    scope: 'Current-database read-only preparation, not a backup or apply proof. Revalidate all inputs before writes; no raw account or credential payload is persisted.' }
  await writeFile(destination, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ manifestHash: result.manifestHash, tables: prepared.frozen.tables.length,
    accountRows: prepared.frozen.account.sourceRows, entities: prepared.frozen.account.entityCount,
    ownershipRows: prepared.frozen.ownership.sourceRows, grants: prepared.frozen.ownership.grantCount, databaseWrites: 0 }))
} catch (error) {
  console.error(JSON.stringify({ failed: true, code: /^[A-Z_]+$/.test(error.code ?? '') ? error.code : 'current_account_wave_preparation_failed' }))
  process.exitCode = 1
} finally { if (connection) await connection.end().catch(() => {}) }
