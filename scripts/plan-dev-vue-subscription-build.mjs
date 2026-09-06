import { readFile, writeFile } from 'node:fs/promises'
import mysql from 'mysql2/promise'
import { parse } from 'dotenv'
import { mysqlColumnStore, verifyInplaceJournal, withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { loadSubscriptionBuild, subscriptionBuildStore, executeSubscriptionBuild } from './lib/inplace-subscription-build.mjs'

const root = new URL('../', import.meta.url)
let connection
try {
  if (process.argv.length !== 2) throw new Error('arguments')
  const env = parse(await readFile(new URL('server/.env', root)))
  if (env.MYSQL_DATABASE !== 'dev_vue') throw new Error('database')
  connection = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, timezone: 'Z', dateStrings: true })
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  if (identity.db !== 'dev_vue' || identity.uuid !== 'ac423207-6ef3-11f1-b302-000c29fda104') throw new Error('identity')
  await connection.query("SET SESSION time_zone='+00:00'")
  if (!await verifyInplaceJournal(connection)) throw new Error('journal')
  const plan = await loadSubscriptionBuild(root)
  const result = await withInplaceUpgradeLock(connection, identity.db, async () => {
    await connection.query('START TRANSACTION READ ONLY')
    try { return await executeSubscriptionBuild(subscriptionBuildStore(connection, mysqlColumnStore(connection, true), plan), plan) }
    finally { await connection.rollback() }
  })
  const report = { observedAt: new Date().toISOString(), identity, result, steps: plan.steps.map(({ id, checksum, beforeHash, afterHash }) => ({ id, checksum, beforeHash, afterHash })), businessWritesPerformed: false }
  await writeFile(new URL('docs/migration/dev-vue-subscription-build-plan-20260907.json', root), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify(result))
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', code: error.code ?? (/^inplace_/.test(error.message) ? error.message : 'subscription_build_plan_failed') }))
  process.exitCode = 1
} finally { await connection?.end() }
