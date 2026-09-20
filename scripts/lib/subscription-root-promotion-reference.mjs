import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { splitSqlStatements } from './v4-migration-plan.mjs'
import { subscriptionBuildFixture } from './subscription-build-writer-reference.mjs'
import { createSubscriptionBuildWriter } from './mysql-subscription-build-writer.mjs'
import { subscriptionRootRenameSql, subscriptionRootSnapshot, classifySubscriptionPromotion } from './subscription-root-promotion.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'
import { verifySubscriptionExecutionWindow } from './subscription-execution-window-reference.mjs'

const sha = text => createHash('sha256').update(text).digest('hex')
const quote = name => { assert.match(name, /^[a-z][a-z0-9_]*$/); return `\`${name}\`` }

export async function verifySubscriptionRootPromotion(adminConnection, report, openDatabase) {
  const [[origin]] = await adminConnection.query('SELECT DATABASE() db,@@server_uuid uuid')
  assert.match(origin.db, /^dev_vue_strategy_ref_[a-f0-9]{32}$/)
  assert.equal(origin.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  const database = 'dev_vue_subscription_ref_' + randomUUID().replaceAll('-', '')
  const result = { passed: false, checks: [], referenceDatabase: database, referenceDatabaseRemoved: false,
    scope: 'Isolated migration-derived subscription DDL and fixture rows; no historical restore, write freeze, journal or existing dev_vue upgrade proof.' }
  report.subscriptionPromotion = result
  let created = false
  let connection
  try {
    await adminConnection.query(`CREATE DATABASE ${quote(database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`); created = true
    // Prepared statements remain bound to their original schema after USE.
    // A fresh connection prevents the reference writer from reaching another fixture database.
    connection = await openDatabase(database)
    const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
    assert.equal(identity.db, database); assert.equal(identity.uuid, origin.uuid)
    await connection.query("SET SESSION time_zone='+00:00'")
    const referenceText = await readFile(new URL('../../docs/architecture/strategy-receipt-inventory-v3-20260909.json', import.meta.url), 'utf8')
    const reference = JSON.parse(referenceText)
    assert.equal(reference.identity.db, 'dev_vue'); assert.equal(reference.identity.uuid, origin.uuid)
    const strategyDdl = await readFile(new URL('../../server/db/migrations/inplace/006_strategy_tables.sql', import.meta.url), 'utf8')
    const buildDdl = await readFile(new URL('../../server/db/migrations/inplace/007_subscription_build_tables.sql', import.meta.url), 'utf8')
    result.sourceHashes = { reference: sha(referenceText), strategyDdl: sha(strategyDdl), buildDdl: sha(buildDdl) }
    await connection.query('CREATE TABLE users (id INT PRIMARY KEY) ENGINE=InnoDB')
    await connection.query('CREATE TABLE trading_accounts_legacy_v3 (id INT PRIMARY KEY) ENGINE=InnoDB')
    await connection.query('CREATE TABLE trading_accounts_v4_build (id BIGINT UNSIGNED PRIMARY KEY) ENGINE=InnoDB')
    await connection.query('INSERT INTO users VALUES (7)')
    await connection.query('INSERT INTO trading_accounts_legacy_v3 VALUES (9)')
    await connection.query('INSERT INTO trading_accounts_v4_build VALUES (5)')
    for (const sql of splitSqlStatements(strategyDdl)) await connection.query(sql)
    for (const sql of splitSqlStatements(buildDdl)) await connection.query(sql)
    await connection.query('RENAME TABLE trading_accounts_v4_build TO trading_accounts')
    await connection.query(reference.definitions.strategy_subscriptions)
    for (const table of ['strategies', 'strategy_versions', 'strategy_subscriptions', 'strategy_subscriptions_v4_build',
      'subscription_schedules_v4_build', 'subscription_execution_preferences_v4_build']) {
      const [[definition]] = await connection.query(`SHOW CREATE TABLE ${quote(table)}`)
      assert.equal(tableDefinitionHash(definition['Create Table']), tableDefinitionHash(reference.definitions[table]))
    }
    result.checks.push('six-table-ddl-matches-archived-dev-vue-before-promotion')
    await connection.query(`INSERT INTO strategy_subscriptions (id,user_id,trading_account_id,strategy_id,symbols_json,memory_mode,
      created_at,updated_at) VALUES (21,7,9,1,'["XAUUSD"]','platform_only','2026-09-09 00:00:00','2026-09-09 00:00:00')`)
    await connection.query(`CREATE TABLE legacy_subscription_reference (id INT PRIMARY KEY,subscription_id INT NOT NULL,
      CONSTRAINT fixture_legacy_subscription_fk FOREIGN KEY(subscription_id) REFERENCES strategy_subscriptions(id)) ENGINE=InnoDB`)
    await connection.query('INSERT INTO legacy_subscription_reference VALUES (1,21)')
    await connection.query(`INSERT INTO strategies (id,kind,scope,name,status,created_at_utc,updated_at_utc)
      VALUES (1,'analysis','platform','fixture','active',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`)
    await connection.execute(`INSERT INTO strategy_versions (id,strategy_id,version_number,prompt_text,prompt_sha256,input_contract_version,
      output_contract_version,config_json,created_by_user_id,created_at_utc) VALUES (11,1,1,'fixture',?,'fixture/v1','fixture/v1','{}',7,UTC_TIMESTAMP(3))`, [sha('fixture')])
    await connection.query(`INSERT INTO strategies (id,kind,scope,name,status,created_at_utc,updated_at_utc)
      VALUES (2,'trader','platform','window fixture','active',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))`)
    await connection.execute(`INSERT INTO strategy_versions (id,strategy_id,version_number,prompt_text,prompt_sha256,
      input_contract_version,output_contract_version,config_json,created_by_user_id,created_at_utc)
      VALUES (22,2,1,'fixture',?,'fixture/v1','fixture/v1','{}',7,UTC_TIMESTAMP(3))`, ['a'.repeat(64)])
    await connection.query(`CREATE TABLE trading_projection_revisions (
      trading_account_id BIGINT UNSIGNED,resource_kind VARCHAR(32),resource_id VARCHAR(32),revision BIGINT UNSIGNED) ENGINE=InnoDB`)
    await connection.query('CREATE TABLE open_position_snapshots (trading_account_id BIGINT UNSIGNED,payload_json JSON) ENGINE=InnoDB')
    await connection.query('CREATE TABLE pending_order_snapshots (trading_account_id BIGINT UNSIGNED,payload_json JSON) ENGINE=InnoDB')
    await connection.query('CREATE TABLE account_risk_summaries (trading_account_id BIGINT UNSIGNED PRIMARY KEY,payload_json JSON,revision BIGINT UNSIGNED) ENGINE=InnoDB')
    await connection.query('CREATE TABLE account_runtime_snapshots (trading_account_id BIGINT UNSIGNED PRIMARY KEY,revision BIGINT UNSIGNED) ENGINE=InnoDB')
    await connection.query('CREATE TABLE market_quotes (trading_account_id BIGINT UNSIGNED,symbol VARCHAR(64),revision BIGINT UNSIGNED,PRIMARY KEY(trading_account_id,symbol)) ENGINE=InnoDB')
    await connection.query('CREATE TABLE market_instrument_snapshots (trading_account_id BIGINT UNSIGNED,symbol VARCHAR(64),revision BIGINT UNSIGNED,PRIMARY KEY(trading_account_id,symbol)) ENGINE=InnoDB')
    const projection = subscriptionBuildFixture('1', '11')
    await createSubscriptionBuildWriter([projection]).write(connection, projection)
    const snapshot = async () => {
      const [names] = await connection.query('SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME')
      const tables = []
      for (const { name } of names) {
        const [[definition]] = await connection.query(`SHOW CREATE TABLE ${quote(name)}`)
        const [columns] = await connection.execute('SELECT COLUMN_NAME name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [name])
        const [rows] = await connection.query(`SELECT ${columns.map(({ name }) => quote(name)).join(',')} FROM ${quote(name)}`)
        // Include invisible/generated columns and use a sorted multiset, not driver row order.
        const serialized = rows.map(row => JSON.stringify({ ...row })).sort()
        tables.push({ name, ddl: definition['Create Table'], rows: rows.length, rowsSha256: sha(JSON.stringify(serialized)) })
      }
      return tables
    }
    const tables = await snapshot(), proof = { before: subscriptionRootSnapshot(tables), after: subscriptionRootSnapshot(tables, { promote: true }) }
    result.before = proof.before; result.expectedAfter = proof.after
    assert.equal(classifySubscriptionPromotion(proof.before, proof), 'pending')
    await connection.query('CREATE TABLE subscription_schedules (id INT PRIMARY KEY) ENGINE=InnoDB')
    const collision = subscriptionRootSnapshot(await snapshot())
    await assert.rejects(connection.query(subscriptionRootRenameSql()), { code: 'ER_TABLE_EXISTS_ERROR' })
    assert.deepEqual(subscriptionRootSnapshot(await snapshot()), collision)
    await connection.query('DROP TABLE subscription_schedules')
    assert.deepEqual(subscriptionRootSnapshot(await snapshot()), proof.before)
    result.checks.push('destination-collision-leaves-all-tables-unchanged')
    const renameThenLoseReply = async () => { await connection.query(subscriptionRootRenameSql()); throw Error('injected_ddl_ack_loss') }
    await assert.rejects(renameThenLoseReply(), /injected_ddl_ack_loss/)
    const after = subscriptionRootSnapshot(await snapshot())
    assert.equal(classifySubscriptionPromotion(after, proof), 'applied'); assert.deepEqual(after, proof.after)
    result.checks.push('ack-loss-recognized-from-complete-schema-and-row-state')
    const [foreignKeys] = await connection.query(`SELECT TABLE_NAME name,REFERENCED_TABLE_NAME parent FROM information_schema.KEY_COLUMN_USAGE
      WHERE TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY TABLE_NAME,CONSTRAINT_NAME,ORDINAL_POSITION`)
    assert.ok(foreignKeys.some(row => row.name === 'legacy_subscription_reference' && row.parent === 'strategy_subscriptions_legacy_v3'))
    for (const name of ['subscription_schedules', 'subscription_execution_preferences'])
      assert.ok(foreignKeys.some(row => row.name === name && row.parent === 'strategy_subscriptions'))
    assert.ok(foreignKeys.some(row => row.name === 'strategy_subscriptions' && row.parent === 'trading_accounts'))
    await assert.rejects(connection.query('UPDATE subscription_schedules SET subscription_id=999999'), { code: 'ER_NO_REFERENCED_ROW_2' })
    await assert.rejects(connection.query('UPDATE subscription_schedules SET cadence_seconds=1'), { code: 'ER_CHECK_CONSTRAINT_VIOLATED' })
    await assert.rejects(connection.query('DELETE FROM strategy_subscriptions_legacy_v3 WHERE id=21'), { code: 'ER_ROW_IS_REFERENCED_2' })
    assert.deepEqual(subscriptionRootSnapshot(await snapshot()), proof.after)
    result.checks.push('legacy-and-runtime-foreign-keys-and-checks-preserved')
    result.executionWindow = await verifySubscriptionExecutionWindow(connection)
    assert.deepEqual(subscriptionRootSnapshot(await snapshot()), proof.after)
    await connection.query(subscriptionRootRenameSql({ restore: true }))
    assert.deepEqual(subscriptionRootSnapshot(await snapshot()), proof.before)
    result.checks.push('single-inverse-rename-restores-exact-schema-and-row-state')
    result.passed = true
  } finally {
    try { if (connection) await connection.end() }
    finally { if (created) { await adminConnection.query(`DROP DATABASE ${quote(database)}`); result.referenceDatabaseRemoved = true } }
  }
  return result
}
