import assert from 'node:assert/strict'
import { createMysqlPositionProtectionSummaryReader, createMysqlPositionProtectionClock } from '../../server/dist-v4/modules/risk/composition.js'

/** Session-local query scaffolds; caller already created authorized account fixtures. */
export async function verifyPositionProtectionRiskInputs(db) {
  const [[identity]]=await db.query('SELECT DATABASE() db')
  assert.match(identity.db,/^dev_vue_strategy_ref_[a-f0-9]{32}$/)
  const checks=[], tables=[]
  try {
    await db.query('CREATE TEMPORARY TABLE account_risk_states (trading_account_id BIGINT PRIMARY KEY,user_id INT,revision BIGINT,observed_at_utc DATETIME(3)) ENGINE=InnoDB');tables.push('account_risk_states')
    await db.query('CREATE TEMPORARY TABLE account_risk_summaries (trading_account_id BIGINT PRIMARY KEY,payload_json JSON,revision BIGINT,observed_at_utc DATETIME(3)) ENGINE=InnoDB');tables.push('account_risk_summaries')
    const clock=createMysqlPositionProtectionClock(db),reader=createMysqlPositionProtectionSummaryReader(db), now=await clock.now()
    const summary={accountId:'5',userId:7,businessDate:now.toISOString().slice(0,10),equity:'10000',freeMargin:'9000',marginLevelPercent:1000,
      dailyLossPercent:1,drawdownPercent:1,openPositions:1,pendingOrders:0,totalVolume:'0.02',dailyOpenCount:1,consecutiveLosses:0,
      terminalTimezoneOffsetMinutes:180,clockStatus:'calibrated',lastSuccessfulOpenAt:null,cooldownUntil:null,dataComplete:true,incompleteReasons:[],observedAt:now.toISOString(),revision:4}
    const sqlTime=now.toISOString().replace('T',' ').replace('Z','')
    await db.execute('INSERT INTO account_risk_states VALUES (5,7,4,?)',[sqlTime])
    await db.execute('INSERT INTO account_risk_summaries VALUES (5,?,4,?)',[JSON.stringify(summary),sqlTime])
    await db.beginTransaction()
    try {
      assert.deepEqual(await reader.read(7,'5'),summary)
      assert.ok((await clock.now()).getTime()>=now.getTime())
      assert.equal(await reader.read(8,'5'),null)
      checks.push('actual-canonical-summary-and-trusted-utc-clock-on-caller-transaction')
    } finally {await db.rollback()}
    for (const [name,sql,missing] of [
      ['summary-state-version-mismatch','UPDATE account_risk_states SET revision=5',false],
      ['summary-state-time-mismatch','UPDATE account_risk_states SET observed_at_utc=observed_at_utc+INTERVAL 1 SECOND',false],
      ['summary-body-owner-mismatch',"UPDATE account_risk_summaries SET payload_json=JSON_SET(payload_json,'$.userId',8)",false],
      ['summary-complete-string-not-coerced',"UPDATE account_risk_summaries SET payload_json=JSON_SET(payload_json,'$.dataComplete','false')",false],
      ['summary-clock-missing-not-defaulted',"UPDATE account_risk_summaries SET payload_json=JSON_REMOVE(payload_json,'$.clockStatus')",false],
      ['summary-revoked-owner-unavailable','UPDATE trading_account_ownerships SET revoked_at_utc=UTC_TIMESTAMP(3)',true],
      ['summary-old-ownership-revision-unavailable','UPDATE trading_accounts SET ownership_revision=2',true],
    ]) {
      await db.beginTransaction()
      try {
        await db.query(sql)
        if(missing)assert.equal(await reader.read(7,'5'),null)
        else await assert.rejects(()=>reader.read(7,'5'),error=>error.code==='position_protection_summary_invalid')
        checks.push(name)
      } catch(error) {error.referenceStatement=name;throw error}
      finally {await db.rollback()}
    }
    await db.query("SET time_zone='+08:00'")
    try {await assert.rejects(()=>clock.now(),error=>error.code==='position_protection_utc_required');checks.push('non-utc-session-explicitly-rejected')}
    catch(error) {error.referenceStatement='non-utc-session-explicitly-rejected';throw error}
    finally {await db.query("SET time_zone='+00:00'")}
    return checks
  } finally {
    await db.rollback()
    for(const table of tables.reverse())await db.query(`DROP TEMPORARY TABLE ${table}`)
  }
}
