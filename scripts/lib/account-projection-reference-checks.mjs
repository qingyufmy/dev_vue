import assert from 'node:assert/strict'

export async function verifyAccountProjectionReference(connection, reference) {
  assert.match(reference, /^dev_vue_projection_reference_[a-f0-9]{24}$/)
  const [[identity]] = await connection.query('SELECT DATABASE() db')
  assert.equal(identity.db, reference)
  const checks = [], interval = '00000000-0000-4000-8000-000000000001'
  const reject = async (name, sql, errno) => {
    await assert.rejects(connection.query(sql), error => error.errno === errno)
    checks.push({ name, expectedErrno: errno, passed: true })
  }
  await connection.beginTransaction()
  try {
    await connection.query('INSERT INTO users (id) VALUES (1)')
    await connection.query('INSERT INTO trading_accounts (id) VALUES (1),(2)')
    await connection.query("INSERT INTO terminal_profiles (id) VALUES ('reference-profile')")
    await connection.execute('INSERT INTO trading_account_ownership_intervals (id) VALUES (?)', [interval])
    await connection.query("INSERT INTO account_runtime_snapshots (trading_account_id,balance,equity,margin_amount,free_margin,floating_profit,clock_status,observed_at_utc,revision) VALUES (1,1234567890123456.12345678,1,0,1,-0.12345678,'unavailable','2026-09-08 00:00:00.123',1)")
    const [[account]] = await connection.query('SELECT balance,floating_profit,trade_permission,timezone_offset_minutes,observed_at_utc FROM account_runtime_snapshots WHERE trading_account_id=1')
    assert.equal(account.balance, '1234567890123456.12345678'); assert.equal(account.floating_profit, '-0.12345678')
    assert.equal(Number(account.trade_permission), 0); assert.equal(account.timezone_offset_minutes, null)
    assert.equal(account.observed_at_utc, '2026-09-08 00:00:00.123')
    checks.push({ name: 'exact_decimal_utc_milliseconds_permission_defaults', passed: true })
    await reject('account_snapshot_foreign_key', 'UPDATE account_runtime_snapshots SET trading_account_id=999 WHERE trading_account_id=1', 1452)
    await reject('account_decimal_overflow', 'UPDATE account_runtime_snapshots SET balance=10000000000000000 WHERE trading_account_id=1', 1264)
    await connection.query("INSERT INTO market_quotes (trading_account_id,symbol,bid,ask,spread,trade_mode,observed_at_utc,revision) VALUES (1,'XAUUSD',0.1234567890,0.1234567891,0.0000000001,'unknown',UTC_TIMESTAMP(3),1),(2,'XAUUSD',1,2,1,'disabled',UTC_TIMESTAMP(3),1)")
    const [[quote]] = await connection.query("SELECT bid,ask,spread FROM market_quotes WHERE trading_account_id=1 AND symbol='XAUUSD'")
    assert.deepEqual(quote, { bid: '0.1234567890', ask: '0.1234567891', spread: '0.0000000001' })
    checks.push({ name: 'quote_decimal_precision_and_account_scoping', passed: true })
    await reject('quote_duplicate_account_symbol', "INSERT INTO market_quotes (trading_account_id,symbol,bid,ask,spread,trade_mode,observed_at_utc,revision) VALUES (1,'XAUUSD',1,2,1,'unknown',UTC_TIMESTAMP(3),2)", 1062)
    await reject('quote_account_foreign_key', 'UPDATE market_quotes SET trading_account_id=999 WHERE trading_account_id=2', 1452)
    const payload = { ticket: '9007199254740993', price: '0.1234567890' }
    for (const table of ['open_position_snapshots', 'pending_order_snapshots']) {
      await connection.execute('INSERT INTO `' + table + '` (trading_account_id,ticket,payload_json,revision,observed_at_utc) VALUES (1,?,?,1,UTC_TIMESTAMP(3)),(2,?,?,1,UTC_TIMESTAMP(3))',
        [payload.ticket, JSON.stringify(payload), payload.ticket, JSON.stringify(payload)])
      const [[row]] = await connection.query('SELECT ticket,payload_json FROM `' + table + '` WHERE trading_account_id=1')
      assert.equal(row.ticket, payload.ticket); assert.deepEqual(typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) : row.payload_json, payload)
      checks.push({ name: table + '_json_ticket_account_scoping', passed: true })
      await reject(table + '_invalid_json', 'UPDATE `' + table + "` SET payload_json='invalid' WHERE trading_account_id=1", 3140)
      await reject(table + '_account_foreign_key', 'UPDATE `' + table + '` SET trading_account_id=999 WHERE trading_account_id=2', 1452)
    }
    await connection.query("INSERT INTO trading_projection_revisions (trading_account_id,resource_kind,resource_id,revision,updated_at_utc) VALUES (1,'account.metrics','current',1,UTC_TIMESTAMP(3)),(1,'invalid','current',1,UTC_TIMESTAMP(3))")
    await connection.execute("INSERT INTO trading_projection_provenance_v4 (trading_account_id,resource_kind,resource_id,user_id,ownership_interval_id,ownership_revision,terminal_profile_id,terminal_instance_id,connection_epoch,projection_revision,observed_at_utc) VALUES (1,'account.metrics','current',1,?,1,'reference-profile','reference-instance',1,1,UTC_TIMESTAMP(3))", [interval])
    checks.push({ name: 'valid_projection_provenance', passed: true })
    await reject('provenance_kind_check', "UPDATE trading_projection_provenance_v4 SET resource_kind='invalid'", 3819)
    await reject('provenance_composite_revision_fk', "UPDATE trading_projection_provenance_v4 SET resource_id='missing'", 1452)
    await reject('provenance_user_fk', 'UPDATE trading_projection_provenance_v4 SET user_id=999', 1452)
    await reject('provenance_interval_fk', "UPDATE trading_projection_provenance_v4 SET ownership_interval_id='missing'", 1452)
    await reject('provenance_profile_fk', "UPDATE trading_projection_provenance_v4 SET terminal_profile_id='missing'", 1452)
    await reject('referenced_revision_delete', "DELETE FROM trading_projection_revisions WHERE resource_kind='account.metrics'", 1451)
    await reject('revision_account_fk', "UPDATE trading_projection_revisions SET trading_account_id=999 WHERE resource_kind='invalid'", 1452)
  } finally { await connection.rollback() }
  return checks
}
