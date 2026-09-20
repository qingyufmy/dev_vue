import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { parse } from 'dotenv'
import mysql from 'mysql2/promise'
import { loadRiskReapprovalUpgrade } from './lib/risk-reapproval-upgrade.mjs'
import { tableDefinitionHash } from './lib/inplace-foundation-upgrade.mjs'
import { withInplaceUpgradeLock, verifyInplaceJournal } from './lib/mysql-inplace-column-store.mjs'

assert.ok(process.argv.length === 3 && process.argv[2] === '--apply')
const root = new URL('../', import.meta.url), plan = await loadRiskReapprovalUpgrade(root), step = plan.reapproval
const env = parse(await readFile(new URL('server/.env', root)))
assert.equal(env.MYSQL_DATABASE, 'dev_vue')
const db = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306),
  user: env.MYSQL_USER, password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE })
try {
  await db.query('SET SESSION lock_wait_timeout=10')
  await withInplaceUpgradeLock(db, env.MYSQL_DATABASE, async () => {
    assert.equal(await verifyInplaceJournal(db), true)
    const [history] = await db.query('SELECT id,checksum_sha256 checksum,status FROM database_upgrade_steps_v4')
    for (const expected of plan.steps.slice(0, -1)) {
      const row = history.find(item => item.id === expected.id)
      assert.ok(row && row.status === 'completed' && row.checksum === expected.checksum, 'prior_upgrade_mismatch:' + expected.id)
    }
    assert.ok(history.every(row => plan.steps.some(expected => expected.id === row.id)), 'unknown_upgrade')
    const prior = history.find(row => row.id === step.id)
    if (prior) assert.equal(prior.checksum, step.checksum)
    const definition = async () => {
      const [rows] = await db.query('SHOW CREATE TABLE risk_decisions_v4')
      return tableDefinitionHash(rows[0]['Create Table'])
    }
    const before = await definition()
    assert.ok(before === step.beforeHash || before === step.afterHash, 'risk_schema_mismatch')
    if (prior?.status === 'completed') assert.equal(before, step.afterHash)
    else {
      if (!prior) {
        assert.equal(before, step.beforeHash, 'unregistered_schema_change')
        await db.execute("INSERT INTO database_upgrade_steps_v4 (id,checksum_sha256,status,started_at_utc) VALUES (?,?,'started',UTC_TIMESTAMP(3))", [step.id, step.checksum])
      }
      if (before === step.beforeHash) await db.query(step.sql)
      assert.equal(await definition(), step.afterHash)
      const [result] = await db.execute("UPDATE database_upgrade_steps_v4 SET status='completed',completed_at_utc=UTC_TIMESTAMP(3) WHERE id=? AND checksum_sha256=? AND status='started'", [step.id, step.checksum])
      assert.equal(result.affectedRows, 1)
    }
    const receipt = { target: env.MYSQL_DATABASE, id: step.id, checksum: step.checksum,
      schemaHash: await definition(), passed: true, replay: prior?.status === 'completed', at: new Date().toISOString(), businessRowWrites: 0 }
    await writeFile(new URL('docs/architecture/risk-reapproval-local-receipt.json', root), JSON.stringify(receipt, null, 2) + '\n')
    console.log(JSON.stringify(receipt))
  })
} finally { await db.end() }
