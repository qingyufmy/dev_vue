import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { parse } from 'dotenv'
import { createMysqlPool } from '../server/dist-v4/bootstrap/runtime-resources.js'
import { verifyInplaceJournal, withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { freezeContextChangesTools } from './lib/mysql-current-context-changes.mjs'
import { coordinateObserverRegistrySeed, loadObserverRegistrySeed } from './lib/observer-registry-seed.mjs'

const [mode, destination] = process.argv.slice(2)
assert.ok(process.argv.length === 4 && ['--inspect', '--rehearse', '--apply'].includes(mode) && isAbsolute(destination))
const output = await open(destination, 'wx', 0o600)
let pool, connection, commitState = 'not_attempted', phase = 'frozen-inputs'
try {
  const root = new URL('../', import.meta.url)
  const proof = JSON.parse(await readFile(new URL('docs/architecture/current-context-changes-proof-20260908.json', root)))
  assert.deepEqual(await freezeContextChangesTools(root), proof.tools)
  const plan = await loadObserverRegistrySeed(root)
  const env = parse(await readFile(new URL('server/.env', root)))
  assert.equal(env.MYSQL_HOST, '192.168.1.254'); assert.equal(env.MYSQL_DATABASE, 'dev_vue')
  pool = createMysqlPool({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, poolSize: 1 })
  connection = await pool.getConnection()
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid serverUuid,@@session.time_zone timezone')
  assert.equal(identity.db, 'dev_vue'); assert.equal(identity.serverUuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  assert.equal(identity.timezone, '+00:00')
  phase = 'coordinate'
  const result = await withInplaceUpgradeLock(connection, identity.db, async () => {
    assert.equal(await verifyInplaceJournal(connection), true)
    const [tables] = await connection.query("SELECT ENGINE engine,TABLE_TYPE kind FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='observer_management_registry'")
    assert.deepEqual(tables, [{ engine: 'InnoDB', kind: 'BASE TABLE' }])
    const [columns] = await connection.query("SELECT COLUMN_NAME name,COLUMN_TYPE type,IS_NULLABLE nullable,COLUMN_KEY columnKey FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='observer_management_registry' ORDER BY ORDINAL_POSITION")
    assert.deepEqual(columns.map(row => [row.name, row.type, row.nullable, row.columnKey]), [['id', 'tinyint unsigned', 'NO', 'PRI'], ['revision', 'bigint unsigned', 'NO', '']])
    const [triggers] = await connection.query("SELECT TRIGGER_NAME name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE='observer_management_registry'")
    assert.equal(triggers.length, 0)
    if (mode === '--rehearse') {
      const before = await coordinateObserverRegistrySeed(connection, plan)
      assert.equal(before.state, 'pending'); assert.equal(before.revision, null)
      await assert.rejects(coordinateObserverRegistrySeed(connection, plan, { apply: true, beforeCommit: async () => {
        throw Error('observer_seed_rehearsal_rollback')
      } }), /^Error: observer_seed_rehearsal_rollback$/)
      const after = await coordinateObserverRegistrySeed(connection, plan)
      assert.deepEqual(after, before)
      return { ...after, rollbackVerified: true }
    }
    return coordinateObserverRegistrySeed(connection, plan, { apply: mode === '--apply', beforeCommit: async () => {
      commitState = 'attempted'
      await output.writeFile(JSON.stringify({ passed: false, phase: 'commit', commitState, step: plan.step.id }) + '\n')
      await output.sync()
    } })
  })
  if (commitState === 'attempted') commitState = 'confirmed'
  // Replace the preliminary marker only after the commit acknowledgement; the file remains exclusive to this run.
  await output.truncate(0)
  await output.write(JSON.stringify({ kind: 'local-observer-registry-upgrade/v1', observedAt: new Date().toISOString(),
    passed: true, mode, identity, result, commitState, step: plan.step, frozenInputs: proof.tools.length,
    scope: 'Single required seed plus atomic append-only migration ledger. Existing revisions and all business/history rows preserved. No DDL, runtime startup or terminal action.' }, null, 2) + '\n', 0, 'utf8')
  console.log(JSON.stringify({ passed: true, mode, result, commitState }))
} catch (error) {
  await output.truncate(0)
  await output.write(JSON.stringify({ passed: false, phase, commitState,
    code: /^observer_seed_[a-z_]+$/.test(error.message ?? '') ? error.message : 'observer_seed_upgrade_failed',
    recovery: 'Use --inspect with a new report; never reset a revision or automatically retry uncertain COMMIT.' }) + '\n', 0, 'utf8')
  console.log(JSON.stringify({ passed: false, phase, commitState })); process.exitCode = 1
} finally {
  if (connection) connection.destroy()
  if (pool) await pool.end()
  await output.sync(); await output.close()
}
