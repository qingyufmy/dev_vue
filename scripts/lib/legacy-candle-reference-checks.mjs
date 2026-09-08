import assert from 'node:assert/strict'

export async function verifyLegacyCandleReference(connection, reference) {
  assert.match(reference, /^dev_vue_candle_reference_[a-f0-9]{24}$/)
  const [[identity]] = await connection.query('SELECT DATABASE() db')
  assert.equal(identity.db, reference)
  const checks = []
  const reject = async (name, sql, errno) => {
    await assert.rejects(connection.query(sql), error => error.errno === errno)
    checks.push({ name, expectedErrno: errno, passed: true })
  }
  const seed = async () => {
    await connection.query('INSERT INTO trading_accounts (id) VALUES (1),(2)')
    await connection.query('INSERT INTO market_data_sources (id) VALUES (1)')
    await connection.query('INSERT INTO market_candles (id) VALUES (1),(9007199254740993)')
    await connection.query("INSERT INTO legacy_candle_backfill_v4 (id,conversion_plan_hash,source_plan_hash,source_rows_hash,mapping_hash,projection_hash,expected_source_rows,expected_projection_rows,created_at_utc,updated_at_utc) VALUES (1,REPEAT('a',64),REPEAT('b',64),REPEAT('c',64),REPEAT('d',64),REPEAT('e',64),2,1,'2026-09-08 00:00:00.123','2026-09-08 00:00:00.123')")
    await connection.query("INSERT INTO market_candles_build_v4 (trading_account_id,symbol,timeframe,open_time_utc,open_price,high_price,low_price,close_price,tick_volume,closed,revision) VALUES (1,'XAUUSD','M5','2025-04-25 17:00:00.123',12345678901234.1234567890,12345678901235,1,-0.1234567890,9999999999999999.00000000,1,1)")
    await connection.query("INSERT INTO legacy_candle_mappings_v4 (legacy_candle_id,run_id,source_id,trading_account_id,symbol,timeframe,open_time_utc,target_key_hash,payload_hash,source_hash) VALUES (1,1,1,1,'XAUUSD','M5','2025-04-25 17:00:00.123',REPEAT('f',64),REPEAT('a',64),REPEAT('b',64)),(9007199254740993,1,1,1,'XAUUSD','M5','2025-04-25 17:00:00.123',REPEAT('f',64),REPEAT('a',64),REPEAT('c',64))")
  }
  await connection.beginTransaction()
  try {
    await seed()
    const [[row]] = await connection.query("SELECT open_time_utc,open_price,close_price,tick_volume FROM market_candles_build_v4 WHERE trading_account_id=1")
    assert.deepEqual(row, { open_time_utc: '2025-04-25 17:00:00.123', open_price: '12345678901234.1234567890',
      close_price: '-0.1234567890', tick_volume: '9999999999999999.00000000' })
    checks.push({ name: 'exact_decimal_and_utc_milliseconds', passed: true })
    const [mappings] = await connection.query('SELECT CAST(legacy_candle_id AS CHAR) id FROM legacy_candle_mappings_v4 ORDER BY legacy_candle_id')
    assert.deepEqual(mappings.map(item => item.id), ['1', '9007199254740993'])
    checks.push({ name: 'multiple_original_rows_share_one_projection_with_exact_ids', passed: true })
    await reject('singleton_checkpoint', "INSERT INTO legacy_candle_backfill_v4 (id,conversion_plan_hash,source_plan_hash,source_rows_hash,mapping_hash,projection_hash,expected_source_rows,expected_projection_rows,created_at_utc,updated_at_utc) SELECT 2,REPEAT('1',64),source_plan_hash,source_rows_hash,mapping_hash,projection_hash,expected_source_rows,expected_projection_rows,created_at_utc,updated_at_utc FROM legacy_candle_backfill_v4", 3819)
    await reject('premature_verified', "UPDATE legacy_candle_backfill_v4 SET status='verified'", 3819)
    await reject('mapped_count_bound', 'UPDATE legacy_candle_backfill_v4 SET mapped_rows=3', 3819)
    await reject('projection_count_bound', 'UPDATE legacy_candle_backfill_v4 SET mapped_rows=2,projection_rows=2', 3819)
    await reject('projection_exceeds_mapped', 'UPDATE legacy_candle_backfill_v4 SET projection_rows=1', 3819)
    await reject('original_row_fk', 'UPDATE legacy_candle_mappings_v4 SET legacy_candle_id=999 WHERE legacy_candle_id=1', 1452)
    await reject('source_fk', 'UPDATE legacy_candle_mappings_v4 SET source_id=999 WHERE legacy_candle_id=1', 1452)
    await reject('run_fk', 'UPDATE legacy_candle_mappings_v4 SET run_id=2 WHERE legacy_candle_id=1', 1452)
    await reject('target_composite_fk', "UPDATE legacy_candle_mappings_v4 SET symbol='xauusd' WHERE legacy_candle_id=1", 1452)
    await reject('original_delete_restricted', 'DELETE FROM market_candles WHERE id=1', 1451)
    await reject('target_delete_restricted', 'DELETE FROM market_candles_build_v4 WHERE trading_account_id=1', 1451)
    await reject('price_overflow', 'UPDATE market_candles_build_v4 SET open_price=100000000000000', 1264)
    await connection.query("INSERT INTO market_candles_build_v4 SELECT trading_account_id,'xauusd',timeframe,open_time_utc,open_price,high_price,low_price,close_price,tick_volume,closed,revision FROM market_candles_build_v4 WHERE symbol='XAUUSD'")
    await connection.query("INSERT INTO market_candles_build_v4 SELECT 2,symbol,timeframe,open_time_utc,open_price,high_price,low_price,close_price,tick_volume,closed,revision FROM market_candles_build_v4 WHERE symbol='XAUUSD'")
    const [[count]] = await connection.query('SELECT COUNT(*) n FROM market_candles_build_v4')
    assert.equal(Number(count.n), 3)
    checks.push({ name: 'binary_symbols_and_account_scope', passed: true })
    await connection.query("UPDATE legacy_candle_backfill_v4 SET mapped_rows=2,projection_rows=1,last_legacy_id=9007199254740993,status='verified'")
    checks.push({ name: 'valid_complete_checkpoint', passed: true })
  } finally { await connection.rollback() }

  // DDL implicitly commits. Use a separate, explicitly committed synthetic fixture.
  await connection.beginTransaction()
  try { await seed(); await connection.commit() }
  catch (error) { await connection.rollback(); throw error }
  await connection.query('RENAME TABLE market_candles TO market_candles_legacy_v3, market_candles_build_v4 TO market_candles')
  const [foreignKeys] = await connection.query("SELECT CONSTRAINT_NAME constraintName,REFERENCED_TABLE_NAME referencedTable,COLUMN_NAME columnName FROM information_schema.KEY_COLUMN_USAGE WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='legacy_candle_mappings_v4' AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY CONSTRAINT_NAME,ORDINAL_POSITION")
  assert.ok(foreignKeys.filter(row => row.constraintName === 'fk_legacy_candle_original').every(row => row.referencedTable === 'market_candles_legacy_v3'))
  assert.equal(foreignKeys.filter(row => row.constraintName === 'fk_legacy_candle_original').length, 1)
  assert.equal(foreignKeys.filter(row => row.constraintName === 'fk_legacy_candle_target' && row.referencedTable === 'market_candles').length, 4)
  await reject('promoted_original_delete_restricted', 'DELETE FROM market_candles_legacy_v3 WHERE id=1', 1451)
  await reject('promoted_target_delete_restricted', 'DELETE FROM market_candles WHERE trading_account_id=1', 1451)
  checks.push({ name: 'atomic_rename_preserves_original_and_target_foreign_keys', passed: true })
  const [[joined]] = await connection.query('SELECT COUNT(*) n FROM legacy_candle_mappings_v4 m JOIN market_candles_legacy_v3 o ON o.id=m.legacy_candle_id JOIN market_candles c ON c.trading_account_id=m.trading_account_id AND c.symbol=m.symbol AND c.timeframe=m.timeframe AND c.open_time_utc=m.open_time_utc')
  assert.equal(Number(joined.n), 2)
  checks.push({ name: 'both_mappings_resolve_after_promotion', passed: true })
  const promotedDefinitions = []
  for (const table of ['market_candles_legacy_v3', 'market_candles', 'legacy_candle_mappings_v4']) {
    const [[row]] = await connection.query('SHOW CREATE TABLE `' + table + '`')
    promotedDefinitions.push({ table, ddl: row['Create Table'] })
  }
  await connection.beginTransaction()
  try {
    for (const table of ['legacy_candle_mappings_v4', 'legacy_candle_backfill_v4', 'market_candles', 'market_candles_legacy_v3', 'market_data_sources', 'trading_accounts']) {
      await connection.query('DELETE FROM `' + table + '`')
    }
    await connection.commit()
  } catch (error) { await connection.rollback(); throw error }
  return { checks, foreignKeys, promotedDefinitions }
}
