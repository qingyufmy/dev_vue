import assert from 'node:assert/strict'

// Only the caller's freshly created, empty reference schema may be used.
// Fixtures never belong to dev_vue or its restored business data.
export async function verifyObserverContextReference(connection, reference) {
  assert.match(reference, /^dev_vue_observer_reference_[a-f0-9]{24}$/)
  const [[identity]] = await connection.query('SELECT DATABASE() db')
  assert.equal(identity.db, reference)
  const checks = []
  const reject = async (name, sql, errno) => {
    await assert.rejects(connection.query(sql), error => error.errno === errno)
    checks.push({ name, expectedErrno: errno, passed: true })
  }
  await connection.beginTransaction()
  try {
    await connection.query('INSERT INTO users (id) VALUES (1),(2)')
    await connection.query('INSERT INTO trading_accounts (id) VALUES (1)')
    await connection.query('INSERT INTO strategies (id) VALUES (1)')
    await connection.query("INSERT INTO observer_sources (id,display_name,operator_user_id,created_by_user_id,created_at_utc,updated_at_utc) VALUES (1,'reference',1,1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))")
    const [[source]] = await connection.query('SELECT status,configuration_status,revision FROM observer_sources WHERE id=1')
    assert.equal(source.status, 'disabled'); assert.equal(source.configuration_status, 'pending'); assert.equal(String(source.revision), '1')
    checks.push({ name: 'source_disabled_pending_defaults', passed: true })
    await reject('source_ready_requires_account', "UPDATE observer_sources SET configuration_status='ready' WHERE id=1", 3819)
    await reject('source_strategy_foreign_key', 'UPDATE observer_sources SET analysis_strategy_id=999 WHERE id=1', 1452)
    await reject('source_account_foreign_key', 'UPDATE observer_sources SET trading_account_id=999 WHERE id=1', 1452)
    await connection.query("UPDATE observer_sources SET trading_account_id=1,analysis_strategy_id=1,configuration_status='ready' WHERE id=1")
    await connection.query("INSERT INTO observer_channels (id,display_name,source_id,created_by_user_id,created_at_utc) VALUES (1,'one',1,1,UTC_TIMESTAMP(3)),(2,'two',1,1,UTC_TIMESTAMP(3))")
    const [channels] = await connection.query('SELECT active,audience,is_default,default_slot FROM observer_channels ORDER BY id')
    assert.equal(channels.length, 2)
    for (const row of channels) { assert.equal(Number(row.active), 0); assert.equal(row.audience, 'assigned'); assert.equal(Number(row.is_default), 0); assert.equal(row.default_slot, null) }
    checks.push({ name: 'channels_inactive_assigned_multiple_nondefault', passed: true })
    await connection.query('UPDATE observer_channels SET is_default=1 WHERE id=1')
    await reject('only_one_default_channel', 'UPDATE observer_channels SET is_default=1 WHERE id=2', 1062)
    await reject('default_flag_boolean', 'UPDATE observer_channels SET is_default=2 WHERE id=2', 3819)
    await reject('channel_source_foreign_key', 'UPDATE observer_channels SET source_id=999 WHERE id=2', 1452)
    await connection.query('UPDATE observer_channels SET is_default=0 WHERE id=1')
    await connection.query('UPDATE observer_channels SET is_default=1 WHERE id=2')
    checks.push({ name: 'default_channel_can_transfer', passed: true })
    await connection.query('INSERT INTO observer_channel_accesses (observer_channel_id,user_id,granted_by_user_id,granted_at_utc) VALUES (1,2,1,UTC_TIMESTAMP(3))')
    await reject('access_channel_foreign_key', 'UPDATE observer_channel_accesses SET observer_channel_id=999 WHERE user_id=2', 1452)
    await reject('access_granter_foreign_key', 'UPDATE observer_channel_accesses SET granted_by_user_id=999 WHERE user_id=2', 1452)
    await connection.query("INSERT INTO trading_contexts (user_id,mode,updated_at_utc) VALUES (1,'blocked',UTC_TIMESTAMP(3))")
    await reject('blocked_context_read_only', 'UPDATE trading_contexts SET read_only=0 WHERE user_id=1', 3819)
    await reject('full_context_requires_account', "UPDATE trading_contexts SET mode='full' WHERE user_id=1", 3819)
    await connection.query("UPDATE trading_contexts SET mode='full',trading_account_id=1,read_only=0 WHERE user_id=1")
    await reject('full_context_excludes_channel', 'UPDATE trading_contexts SET observer_channel_id=1 WHERE user_id=1', 3819)
    await connection.query("UPDATE trading_contexts SET mode='observer',trading_account_id=NULL,observer_channel_id=1,read_only=1 WHERE user_id=1")
    await reject('observer_context_read_only', 'UPDATE trading_contexts SET read_only=0 WHERE user_id=1', 3819)
    await reject('context_user_foreign_key', 'UPDATE trading_contexts SET user_id=999 WHERE user_id=1', 1452)
    await reject('context_channel_foreign_key', 'UPDATE trading_contexts SET observer_channel_id=999 WHERE user_id=1', 1452)
    checks.push({ name: 'valid_full_and_observer_contexts', passed: true })
  } finally { await connection.rollback() }
  return checks
}
