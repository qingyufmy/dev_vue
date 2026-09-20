import assert from 'node:assert/strict'
import { verifyStrategyReferenceSourceReference } from './strategy-reference-source-reference.mjs'
import { createTransactionStrategyObserverInventoryReader } from '../../server/dist-v4/modules/trading/composition.js'
import { createAccountPrincipalReader } from '../../server/dist-v4/modules/auth/composition.js'
import { BridgeTradeProjectionDecoder } from '../../server/dist-v4/modules/bridge/index.js'

// Runs inside the observer reference's temporary schema; existing databases remain untouched.
export async function verifyStrategyObserverInventoryReference(connection, create) {
  const [[identity]] = await connection.query('SELECT DATABASE() db')
  assert.match(identity.db, /^dev_vue_strategy_ref_[a-f0-9]{32}$/)
  await connection.query("ALTER TABLE trading_accounts ADD platform VARCHAR(8) DEFAULT 'mt5', ADD account_login VARCHAR(64) DEFAULT '0007', ADD broker_server VARCHAR(128) DEFAULT 'broker', ADD currency VARCHAR(8) DEFAULT 'USD'")
  await create('terminal_profiles', 'id VARCHAR(64),user_id INT,platform VARCHAR(8),deleted_at_utc DATETIME(3) NULL')
  await create('terminal_account_bindings', 'trading_account_id BIGINT,terminal_profile_id VARCHAR(64),terminal_instance_id VARCHAR(64),unbound_at_utc DATETIME(3) NULL')
  await create('user_trading_account_settings', 'user_id INT,trading_account_id BIGINT,connection_paused INT')
  await create('account_runtime_snapshots', 'trading_account_id BIGINT,trade_permission INT')
  await create('trading_projection_revisions', 'trading_account_id BIGINT,resource_kind VARCHAR(32),resource_id VARCHAR(32),revision BIGINT')
  await create('trading_projection_provenance_v4', 'trading_account_id BIGINT,resource_kind VARCHAR(32),resource_id VARCHAR(32),projection_revision BIGINT,user_id INT,ownership_interval_id VARCHAR(64),ownership_revision BIGINT,terminal_profile_id VARCHAR(64),terminal_instance_id VARCHAR(64),connection_epoch BIGINT,observed_at_utc DATETIME(3)')
  await create('bridge_connection_sessions', 'user_id INT,trading_account_id BIGINT,terminal_profile_id VARCHAR(64),terminal_instance_id VARCHAR(64),connection_epoch_v4 BIGINT,connection_epoch VARCHAR(64),disconnected_at_utc DATETIME(3) NULL,last_seen_at_utc DATETIME(3)')
  await create('open_position_snapshots', 'trading_account_id BIGINT,ticket BIGINT,revision BIGINT,payload_json JSON')
  await create('pending_order_snapshots', 'trading_account_id BIGINT,ticket BIGINT,revision BIGINT,payload_json JSON')
  await connection.query("INSERT INTO terminal_profiles VALUES ('profile',70,'mt5',NULL)")
  await connection.query("INSERT INTO terminal_account_bindings VALUES (9,'profile','terminal',NULL)")
  await connection.query('INSERT INTO user_trading_account_settings VALUES (70,9,0)')
  await connection.query("INSERT INTO trading_projection_revisions VALUES (9,'positions','open',5),(9,'pending_orders','open',6)")
  const observedAt = new Date(Date.now() - 1000).toISOString().replace('T', ' ').replace('Z', '')
  await connection.execute("INSERT INTO trading_projection_provenance_v4 VALUES (9,'positions','open',5,70,'source-owner',1,'profile','terminal',4,?),(9,'pending_orders','open',6,70,'source-owner',1,'profile','terminal',4,?)", [observedAt, observedAt])
  await connection.query("INSERT INTO bridge_connection_sessions VALUES (70,9,'profile','terminal',4,'v4:connection',NULL,UTC_TIMESTAMP(3))")
  const route = { userId: 70, accountId: '9', platform: 'mt5', brokerServer: 'broker', login: '0007', terminalProfileId: 'profile', terminalInstanceId: 'terminal', connectionId: 'connection', connectionEpoch: 4 }
  const reader = createTransactionStrategyObserverInventoryReader(connection, createAccountPrincipalReader, { async current() { return route } })
  const request = () => reader.read({ userId: 70, sourceAccountId: '9', analysisStrategyId: '60001', asOf: new Date().toISOString() })
  const checks = []
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  try { const value = await request(); assert.ok(value); assert.deepEqual(value.positions, { revision: 5, observedAt: observedAt.replace(' ', 'T') + 'Z', items: [] }); checks.push('full-factory-empty-snapshot') }
  finally { await connection.rollback() }
  for (const [name, sql] of [
    ['paused-account', 'UPDATE user_trading_account_settings SET connection_paused=1'],
    ['binding-replaced', "UPDATE terminal_account_bindings SET terminal_instance_id='other'"],
    ['missing-pending-source', "DELETE FROM trading_projection_provenance_v4 WHERE resource_kind='pending_orders'"],
    ['projection-revision-mismatch', 'UPDATE trading_projection_provenance_v4 SET projection_revision=99'],
    ['ownership-interval-mismatch', "UPDATE trading_projection_provenance_v4 SET ownership_interval_id='other'"],
    ['projection-epoch-mismatch', 'UPDATE trading_projection_provenance_v4 SET connection_epoch=5'],
    ['old-observation', 'UPDATE trading_projection_provenance_v4 SET observed_at_utc=UTC_TIMESTAMP(3)-INTERVAL 60 SECOND'],
    ['disconnected-session', 'UPDATE bridge_connection_sessions SET disconnected_at_utc=UTC_TIMESTAMP(3)'],
    ['old-heartbeat', 'UPDATE bridge_connection_sessions SET last_seen_at_utc=UTC_TIMESTAMP(3)-INTERVAL 60 SECOND'],
    ['other-connection-id', "UPDATE bridge_connection_sessions SET connection_epoch='v4:other'"],
    ['mixed-collection-revision', "INSERT INTO open_position_snapshots VALUES (9,10,4,JSON_OBJECT('accountId','9','ticket','10','revision',4,'symbol','XAUUSD'))"],
  ]) {
    await connection.beginTransaction()
    try { await connection.query(sql); assert.equal(await request(), null); checks.push(name) }
    finally { await connection.rollback() }
  }
  const decoded = await new BridgeTradeProjectionDecoder().decode(route, { payload: {
    stream: 'positions', full_snapshot: true, deletes: [], revision: 5, observed_at_utc_msc: Date.now(),
    upserts: [{ ticket: '10', position_identifier: '18446744073709551615', symbol: 'XAUUSD', direction: 'buy', order_type: 'market',
      magic: 7, volume: '0.1', open_price: '2500', current_price: '2501', stop_limit_price: null, stop_loss: null,
      take_profit: null, expiration_utc_msc: null, profit: '1', opened_at_utc_msc: Date.now() - 5000 }],
  } })
  await connection.beginTransaction()
  try {
    await connection.execute('INSERT INTO open_position_snapshots VALUES (9,10,5,?)', [JSON.stringify(decoded.data[0])])
    assert.equal((await request()).positions.items[0].positionIdentifier, '18446744073709551615')
    assert.equal((await request()).positions.items[0].ticket, '10')
    await connection.query(`UPDATE open_position_snapshots SET payload_json=JSON_SET(payload_json,'$.positionIdentifier','18446744073709551616')`)
    assert.equal(await request(), null)
    checks.push('decoded-position-identifier-json-roundtrip-and-overflow-denial')
  } finally { await connection.rollback() }
  const combinedSource = await verifyStrategyReferenceSourceReference(connection, route)
  return { passed: true, checks, combinedSource, routeEvidence: 'injected-reference-route-not-live-redis', schema: 'isolated-temporary-minimal-fixtures' }
}
