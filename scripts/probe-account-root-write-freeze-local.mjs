import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { withAccountRootWriteFreeze } from './lib/account-root-write-freeze.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'

const target = 'dev_vue_ddl_probe_' + randomBytes(6).toString('hex')
let control, owner, contender, created = false, receipt, output, phase = 'arguments'
try {
  assert.equal(process.argv[2], '--probe'); assert.ok(isAbsolute(process.argv[3] ?? '')); assert.equal(process.argv.length, 4)
  output = await open(process.argv[3], 'wx', 0o600)
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.equal(credentials.host, '127.0.0.1'); assert.equal(credentials.port, 13316); assert.equal(credentials.user, 'root')
  const connect = database => mysql.createConnection({ host: credentials.host, port: credentials.port, user: 'root', password: credentials.password,
    database, multipleStatements: false, connectTimeout: 5000 })
  control = await connect('dev_vue')
  const identity = async () => {
    const [[row]] = await control.query('SELECT DATABASE() db,@@server_uuid uuid')
    assert.equal(row.db, 'dev_vue'); assert.equal(row.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104'); return row
  }
  await identity()
  const [existing] = await control.execute('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [target])
  assert.equal(existing.length, 0)
  phase = 'create-probe'
  await control.query(`CREATE DATABASE \`${target}\``); created = true
  owner = await connect(target); contender = await connect(target)
  await owner.query('CREATE TABLE accounts (id INT PRIMARY KEY,value INT NOT NULL) ENGINE=InnoDB')
  await owner.query('CREATE TABLE accounts_build (id INT PRIMARY KEY,value INT NOT NULL) ENGINE=InnoDB')
  await owner.query('CREATE TABLE settings_build (id INT PRIMARY KEY,account_id INT,FOREIGN KEY (account_id) REFERENCES accounts_build(id)) ENGINE=InnoDB')
  await owner.query('CREATE TABLE journal (id INT PRIMARY KEY,value INT NOT NULL) ENGINE=InnoDB')
  await owner.query('INSERT INTO accounts VALUES (1,10)')
  await owner.query('INSERT INTO accounts_build VALUES (2,20)')
  await owner.query('INSERT INTO settings_build VALUES (1,2)')
  await contender.query('SET SESSION lock_wait_timeout=1')
  const checks = [], initial = ['accounts', 'accounts_build', 'settings_build', 'journal']
  phase = 'freeze'
  await withAccountRootWriteFreeze(owner, contender, target, initial, async held => {
    await assert.rejects(contender.query('UPDATE accounts SET value=11 WHERE id=1'), error => error.errno === 1205)
    checks.push('external_write_blocked')
    await owner.query('INSERT INTO journal VALUES (1,1)')
    await held.assertHeld(); checks.push('journal_autocommit_preserves_locks')
    phase = 'rename'
    await owner.query('RENAME TABLE accounts TO accounts_legacy,accounts_build TO accounts,settings_build TO settings')
    const promoted = ['accounts_legacy', 'accounts', 'settings', 'journal']
    await held.assertHeld(promoted); checks.push('atomic_rename_transfers_locks')
    await assert.rejects(contender.query('UPDATE accounts SET value=21 WHERE id=2'), error => error.errno === 1205)
    await assert.rejects(contender.query('UPDATE accounts_legacy SET value=11 WHERE id=1'), error => error.errno === 1205)
    checks.push('new_and_legacy_names_write_blocked')
    const [[parent]] = await owner.query("SELECT REFERENCED_TABLE_NAME name FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='settings' AND REFERENCED_TABLE_NAME IS NOT NULL")
    assert.equal(parent.name, 'accounts'); checks.push('foreign_key_tracks_promoted_root')
    await owner.query('UPDATE journal SET value=2 WHERE id=1'); await held.assertHeld(promoted)
    await owner.query('UNLOCK TABLES')
    await assert.rejects(held.assertHeld(promoted), /account_root_freeze_lock_lost/)
    checks.push('premature_unlock_detected')
  })
  await contender.query('UPDATE accounts SET value=30 WHERE id=2')
  checks.push('writes_resume_after_release')
  const tools = await Promise.all(['scripts/probe-account-root-write-freeze-local.mjs', 'scripts/lib/account-root-write-freeze.mjs']
    .map(async path => ({ path, sha256: sha256(await readFile(path)) })))
  receipt = { kind: 'account-root-write-freeze-probe/v1', observedAt: new Date().toISOString(), target, serverUuid: (await identity()).uuid,
    checks, tools, currentDevVueWrites: 0, scope: 'Synthetic two-connection DDL/lock probe only; current database promotion remains pending.' }
} catch (error) {
  receipt = { failed: true, phase, code: /^ER_[A-Z_]+$/.test(error.code ?? '') ? error.code
    : /^account_root_freeze_[a-z_]+$/.test(error.message ?? '') ? error.message : 'account_root_write_freeze_probe_failed',
    ...(error.lockEvidence ? { lockEvidence: error.lockEvidence } : {}) }
  process.exitCode = 1
} finally {
  if (owner) owner.destroy()
  if (contender) contender.destroy()
  if (created && control) {
    assert.match(target, /^dev_vue_ddl_probe_[a-f0-9]{12}$/)
    const [[row]] = await control.query('SELECT DATABASE() db,@@server_uuid uuid')
    assert.equal(row.db, 'dev_vue'); assert.equal(row.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
    await control.query(`DROP DATABASE \`${target}\``)
    const [remaining] = await control.execute('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?', [target])
    assert.equal(remaining.length, 0)
    if (receipt) receipt.temporaryDatabaseRemoved = true
  }
  if (control) control.destroy()
  if (output) { try { await output.writeFile(JSON.stringify(receipt, null, 2) + '\n'); await output.sync() } finally { await output.close() } }
  console.log(JSON.stringify(receipt))
}
