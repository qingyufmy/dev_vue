import assert from 'node:assert/strict'
import { createTransactionStrategyObserverAccessReader } from '../../server/dist-v4/modules/trading/composition.js'
import { createAccountPrincipalReader } from '../../server/dist-v4/modules/auth/composition.js'
import { verifyStrategyObserverInventoryReference } from './strategy-observer-inventory-reference.mjs'

export async function verifyStrategyObserverAccessReference(connection) {
  const [[identity]] = await connection.query('SELECT DATABASE() db')
  assert.match(identity.db, /^dev_vue_strategy_ref_[a-f0-9]{32}$/)
  const tables = [], checks = []
  const create = async (name, columns) => {
    await connection.query(`CREATE TEMPORARY TABLE ${name} (${columns}) ENGINE=InnoDB`)
    tables.push(name)
  }
  try {
    // Keep this suite independent of the model-access fixture's persistent user setup.
    await create('users', 'id INT PRIMARY KEY,plan VARCHAR(20),plan_expires_at DATETIME(3) NULL,token_version INT,deletion_status VARCHAR(20),deleted_at DATETIME(3) NULL')
    await connection.query("INSERT INTO users VALUES (70,'pro',NULL,0,'active',NULL)")
    await create('observer_channels', 'id BIGINT PRIMARY KEY,display_name VARCHAR(64),source_id BIGINT,source_trading_account_id BIGINT,slug VARCHAR(64),active INT,audience VARCHAR(16),revision BIGINT')
    await create('observer_sources', 'id BIGINT PRIMARY KEY,trading_account_id BIGINT,analysis_strategy_id BIGINT,revision BIGINT,status VARCHAR(16),configuration_status VARCHAR(16),operator_user_id INT')
    await create('trading_accounts', 'id BIGINT PRIMARY KEY,ownership_revision BIGINT,deleted_at_utc DATETIME(3) NULL')
    await create('observer_channel_accesses', 'observer_channel_id BIGINT,user_id INT,granted_at_utc DATETIME(3),revoked_at_utc DATETIME(3) NULL,revision BIGINT')
    await create('trading_account_ownerships', 'trading_account_id BIGINT,user_id INT,role VARCHAR(16),revoked_at_utc DATETIME(3) NULL,revision BIGINT,interval_id CHAR(36),granted_at_utc DATETIME(3)')
    await create('trading_account_ownership_intervals', 'id CHAR(36),user_id INT,trading_account_id BIGINT,role VARCHAR(16),ended_at_utc DATETIME(3) NULL,started_at_utc DATETIME(3)')
    await connection.query("INSERT INTO observer_channels VALUES (11,'restricted',13,9,'restricted',1,'assigned',1),(12,'reference',13,9,'reference',1,'all',1)")
    await connection.query("INSERT INTO observer_sources VALUES (13,9,60001,1,'active','ready',70)")
    await connection.query('INSERT INTO trading_accounts VALUES (9,1,NULL)')
    await connection.query("INSERT INTO trading_account_ownerships VALUES (9,70,'owner',NULL,1,'source-owner','2026-01-01 00:00:00.000')")
    await connection.query("INSERT INTO trading_account_ownership_intervals VALUES ('source-owner',70,9,'owner',NULL,'2026-01-01 00:00:00.000')")
    const reader = createTransactionStrategyObserverAccessReader(connection, createAccountPrincipalReader)
    const scope = { userId: 70, sourceAccountId: '9', analysisStrategyId: '60001' }
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
    try {
      assert.equal((await reader.read(scope)).authorization.channelId, '12')
      assert.equal(await reader.read({ ...scope, analysisStrategyId: '60002' }), null)
      assert.equal(await reader.read({ ...scope, sourceAccountId: '8' }), null)
      assert.equal(await reader.read({ ...scope, userId: 999999 }), null)
      checks.push('snapshot-exact-source-strategy-and-principal')
    } finally { await connection.rollback() }
    for (const [name, sql] of [
      ['source-strategy-changed', 'UPDATE observer_sources SET analysis_strategy_id=60002'],
      ['source-disabled', "UPDATE observer_sources SET status='disabled'"],
      ['source-pending', "UPDATE observer_sources SET configuration_status='pending'"],
      ['channel-account-mismatch', 'UPDATE observer_channels SET source_trading_account_id=8'],
      ['channel-unpublished', 'UPDATE observer_channels SET active=0'],
      ['owner-revoked', "UPDATE trading_account_ownerships SET revoked_at_utc='2026-01-02 00:00:00'"],
      ['owner-interval-ended', "UPDATE trading_account_ownership_intervals SET ended_at_utc='2026-01-02 00:00:00'"],
      ['owner-interval-start-mismatch', "UPDATE trading_account_ownership_intervals SET started_at_utc='2026-01-02 00:00:00'"],
      ['owner-revision-mismatch', 'UPDATE trading_accounts SET ownership_revision=2'],
      ['account-deleted', "UPDATE trading_accounts SET deleted_at_utc='2026-01-02 00:00:00'"],
      ['operator-missing', 'UPDATE observer_sources SET operator_user_id=999999'],
      ['assigned-without-grant', "UPDATE observer_channels SET audience='assigned'"],
    ]) {
      await connection.beginTransaction()
      try { await connection.query(sql); assert.equal(await reader.read(scope), null); checks.push(name) }
      finally { await connection.rollback() }
    }
    await connection.beginTransaction()
    try {
      await connection.query("UPDATE observer_channels SET audience='assigned'")
      await connection.query("INSERT INTO observer_channel_accesses VALUES (12,70,'2026-01-01 00:00:00',NULL,1)")
      assert.equal((await reader.read(scope)).authorization.accessRevision, '1')
      await connection.query("UPDATE observer_channel_accesses SET revoked_at_utc='2026-01-02 00:00:00'")
      assert.equal(await reader.read(scope), null)
      checks.push('explicit-grant-and-revocation')
    } finally { await connection.rollback() }
    const inventory = await verifyStrategyObserverInventoryReference(connection, create)
    return { passed: true, schema: 'isolated-temporary-minimal-fixtures', foreignKeysVerified: false, checks, inventory }
  } finally {
    for (const name of tables.reverse()) await connection.query(`DROP TEMPORARY TABLE ${name}`)
  }
}
