import assert from 'node:assert/strict'
import { createMysqlExecutionAccountReader, createTransactionTerminalFactRouteGuard } from '../../server/dist-v4/modules/trading/composition.js'

/** Uses the caller's session-local authorization fixtures; never writes an existing database. */
export async function verifyExecutionAccountReference(db,route) {
  const [[identity]]=await db.query('SELECT DATABASE() db')
  assert.match(identity.db,/^dev_vue_strategy_ref_[a-f0-9]{32}$/)
  const checks=[]
  await db.query('CREATE TEMPORARY TABLE account_runtime_snapshots (trading_account_id BIGINT PRIMARY KEY,trade_permission TINYINT,timezone_offset_minutes INT,clock_status VARCHAR(32),revision BIGINT,observed_at_utc DATETIME(3)) ENGINE=InnoDB')
  try {
    await db.query("INSERT INTO account_runtime_snapshots VALUES (5,1,180,'calibrated',3,UTC_TIMESTAMP(3))")
    await db.query("INSERT INTO trading_projection_revisions VALUES (5,'account.metrics','current',3)")
    await db.query("INSERT INTO trading_projection_provenance_v4 SELECT 5,'account.metrics','current',3,7,'interval',1,'profile','terminal-1',1,observed_at_utc FROM account_runtime_snapshots")
    const reader=createMysqlExecutionAccountReader(db,createTransactionTerminalFactRouteGuard(db)),scope={route,maxAgeMs:30000}
    await db.beginTransaction()
    try {
      const facts=await reader.read(scope)
      assert.ok(facts);assert.equal(facts.accountId,'5');assert.equal(facts.account.revision,3);assert.equal(facts.account.tradePermission,true);assert.equal(facts.account.timezoneOffsetMinutes,180)
      checks.push('actual-account-permission-clock-current-source-reader')
    } finally {await db.rollback()}
    for(const [name,sql] of [
      ['account-source-epoch-mismatch',"UPDATE trading_projection_provenance_v4 SET connection_epoch=2 WHERE resource_kind='account.metrics'"],
      ['account-source-revision-mismatch',"UPDATE trading_projection_provenance_v4 SET projection_revision=4 WHERE resource_kind='account.metrics'"],
      ['account-source-time-mismatch',"UPDATE trading_projection_provenance_v4 SET observed_at_utc=observed_at_utc-INTERVAL 1 SECOND WHERE resource_kind='account.metrics'"],
      ['account-snapshot-stale','UPDATE account_runtime_snapshots SET observed_at_utc=UTC_TIMESTAMP(3)-INTERVAL 60 SECOND'],
      ['account-connection-paused','UPDATE user_trading_account_settings SET connection_paused=1'],
      ['account-owner-revoked','UPDATE trading_account_ownerships SET revoked_at_utc=UTC_TIMESTAMP(3)'],
      ['account-unknown-trade-permission','UPDATE account_runtime_snapshots SET trade_permission=NULL'],
    ]) {
      await db.beginTransaction()
      try {await db.query(sql);assert.equal(await reader.read(scope),null);checks.push(name)}
      catch(error){error.referenceStatement=name;throw error}
      finally {await db.rollback()}
    }
    return checks
  } finally {
    await db.rollback()
    await db.query("DELETE FROM trading_projection_provenance_v4 WHERE resource_kind='account.metrics'")
    await db.query("DELETE FROM trading_projection_revisions WHERE resource_kind='account.metrics'")
    await db.query('DROP TEMPORARY TABLE account_runtime_snapshots')
  }
}
