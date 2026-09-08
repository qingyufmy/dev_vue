import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { withAccountSourceFreeze } from './lib/account-source-freeze.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'

const target = 'dev_vue_lock_probe_' + randomBytes(6).toString('hex')
let control, freeze, contender, created = false, receipt
try {
  assert.equal(process.argv[2], '--probe'); assert.ok(isAbsolute(process.argv[3] ?? '')); assert.equal(process.argv.length, 4)
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.equal(credentials.host, '127.0.0.1'); assert.equal(credentials.port, 13316); assert.equal(credentials.user, 'root')
  const connect = database => mysql.createConnection({ host: credentials.host, port: credentials.port, user: 'root', password: credentials.password,
    database, multipleStatements: false, connectTimeout: 5000 })
  control = await connect('dev_vue')
  const [[identity]] = await control.query('SELECT DATABASE() db,@@server_uuid uuid')
  assert.equal(identity.db, 'dev_vue'); assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  const [existing] = await control.execute('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [target])
  assert.equal(existing.length, 0)
  await control.query(`CREATE DATABASE \`${target}\``); created = true
  freeze = await connect(target); contender = await connect(target)
  for (const table of ['bridge_v3_terminal_sessions', 'mt5_account_bindings', 'mt5_account_ownership_history', 'trading_accounts', 'users']) {
    await contender.query(`CREATE TABLE \`${table}\` (id INT PRIMARY KEY, value INT NOT NULL) ENGINE=InnoDB`)
  }
  await contender.query('INSERT INTO users (id,value) VALUES (1,10)')
  await contender.query('CREATE TABLE probe_build (id INT PRIMARY KEY,user_id INT NOT NULL,FOREIGN KEY (user_id) REFERENCES users(id)) ENGINE=InnoDB')
  await contender.query('SET SESSION innodb_lock_wait_timeout=1')
  const checks = []
  await withAccountSourceFreeze(freeze, target, async held => {
    for (const [name, sql] of [
      ['source_update_blocked', 'UPDATE users SET value=20 WHERE id=1'],
      ['source_insert_blocked', 'INSERT INTO users (id,value) VALUES (2,20)'],
      ['empty_source_insert_blocked', 'INSERT INTO mt5_account_ownership_history (id,value) VALUES (1,1)'],
    ]) {
      await assert.rejects(contender.query(sql), error => error.errno === 1205)
      await held.assertHeld(); checks.push(name)
    }
    await contender.query('INSERT INTO probe_build (id,user_id) VALUES (1,1)')
    const [[built]] = await contender.query('SELECT COUNT(*) n FROM probe_build')
    assert.equal(Number(built.n), 1); checks.push('target_fk_write_allowed')
  })
  await contender.query('UPDATE users SET value=30 WHERE id=1')
  await contender.query('INSERT INTO mt5_account_ownership_history (id,value) VALUES (1,1)')
  checks.push('source_writes_allowed_after_release')
  const tools = await Promise.all(['scripts/probe-account-source-freeze-local.mjs', 'scripts/lib/account-source-freeze.mjs']
    .map(async path => ({ path, sha256: sha256(await readFile(path)) })))
  receipt = { kind: 'account-source-freeze-mysql-probe/v1', observedAt: new Date().toISOString(), serverUuid: identity.uuid,
    target, checks, tools, currentDevVueWrites: 0, scope: 'Two independent MySQL connections; synthetic tables only. Not a current-database backfill result.' }
} catch (error) {
  console.error(JSON.stringify({ failed: true, code: 'source_freeze_probe_failed' })); process.exitCode = 1
} finally {
  if (freeze) freeze.destroy()
  if (contender) contender.destroy()
  if (created && control) {
    assert.match(target, /^dev_vue_lock_probe_[a-f0-9]{12}$/)
    const [[identity]] = await control.query('SELECT DATABASE() db,@@server_uuid uuid')
    assert.equal(identity.db, 'dev_vue'); assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
    await control.query(`DROP DATABASE \`${target}\``)
    const [remaining] = await control.execute('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [target])
    assert.equal(remaining.length, 0)
    if (receipt) { receipt.temporaryDatabaseRemoved = true; await writeFile(process.argv[3], JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' }); console.log(JSON.stringify(receipt)) }
  }
  if (control) control.destroy()
}
