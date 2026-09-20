import {verifyPositionProtectionContext} from './position-protection-context-reference.mjs'
import { verifyExecutionAccountReference } from './execution-account-reference.mjs'
import { verifyPositionProtectionRiskInputs } from './position-protection-risk-input-reference.mjs'
import { createPartialCloseProjectionReader } from '../../server/dist-v4/bootstrap/partial-close-progress.js'
import { evaluatePartialCloseProtection } from '../../server/dist-v4/modules/execution/domain/partial-close-protection.js'
import assert from 'node:assert/strict'
import { createMysqlExecutionPositionReader, createMysqlExecutionPositionCollectionReader, createTransactionTerminalFactRouteGuard } from '../../server/dist-v4/modules/trading/composition.js'
import { createPartialCloseWorkflowRegistration } from '../../server/dist-v4/bootstrap/partial-close-registration.js'

/** Actual authorization/target queries on session-local minimal schemas, plus candidate registration in one transaction. */
export async function verifyExecutionPositionReference(db, plan) {
  const [[identity]]=await db.query('SELECT DATABASE() db')
  assert.match(identity.db,/^dev_vue_strategy_ref_[a-f0-9]{32}$/)
  const tables=[],checks=[]
  const create=async(name,columns)=>{
    await db.query(`CREATE TEMPORARY TABLE ${name} (${columns}) ENGINE=InnoDB`)
    tables.push(name)
  }
  try {
    await create('users',`id INT PRIMARY KEY,role VARCHAR(32),plan VARCHAR(32),plan_expires_at DATETIME(3),deletion_status VARCHAR(32),deleted_at DATETIME(3)`)
    await create('trading_accounts',`id BIGINT UNSIGNED PRIMARY KEY,platform VARCHAR(8),broker_server VARCHAR(128),account_login VARCHAR(64),ownership_revision BIGINT,deleted_at_utc DATETIME(3)`)
    await create('trading_account_ownerships',`user_id INT,trading_account_id BIGINT,role VARCHAR(16),interval_id VARCHAR(36),revision BIGINT,granted_at_utc DATETIME(3),revoked_at_utc DATETIME(3)`)
    await create('trading_account_ownership_intervals',`id VARCHAR(36),user_id INT,trading_account_id BIGINT,role VARCHAR(16),started_at_utc DATETIME(3),ended_at_utc DATETIME(3)`)
    await create('terminal_profiles',`id VARCHAR(128),user_id INT,installation_id VARCHAR(128),platform VARCHAR(8),deleted_at_utc DATETIME(3)`)
    await create('terminal_account_bindings',`trading_account_id BIGINT,terminal_profile_id VARCHAR(128),terminal_instance_id VARCHAR(128),unbound_at_utc DATETIME(3)`)
    await create('bridge_refresh_sessions',`id BIGINT,user_id INT,installation_id VARCHAR(128),profile_id VARCHAR(128),generation INT,credential_version INT,revoked_at DATETIME(3)`)
    await create('bridge_connection_sessions',`id VARCHAR(128),user_id INT,trading_account_id BIGINT,terminal_profile_id VARCHAR(128),terminal_instance_id VARCHAR(128),connection_epoch_v4 BIGINT,connection_epoch VARCHAR(128),disconnected_at_utc DATETIME(3),last_seen_at_utc DATETIME(3)`)
    await create('user_trading_account_settings',`user_id INT,trading_account_id BIGINT,connection_paused TINYINT`)
    await create('trading_projection_revisions',`trading_account_id BIGINT,resource_kind VARCHAR(32),resource_id VARCHAR(32),revision BIGINT`)
    await create('trading_projection_provenance_v4',`trading_account_id BIGINT,resource_kind VARCHAR(32),resource_id VARCHAR(32),projection_revision BIGINT,user_id INT,ownership_interval_id VARCHAR(36),ownership_revision BIGINT,terminal_profile_id VARCHAR(128),terminal_instance_id VARCHAR(128),connection_epoch BIGINT,observed_at_utc DATETIME(3)`)
    await create('open_position_snapshots',`trading_account_id BIGINT,ticket VARCHAR(64),revision BIGINT,payload_json JSON`)
    await db.query("INSERT INTO users VALUES (7,'user','pro',NULL,'active',NULL)")
    await db.query("INSERT INTO trading_accounts VALUES (5,'mt5','Broker','42',1,NULL)")
    await db.query("INSERT INTO trading_account_ownerships VALUES (7,5,'owner','interval',1,'2020-01-01',NULL)")
    await db.query("INSERT INTO trading_account_ownership_intervals VALUES ('interval',7,5,'owner','2020-01-01',NULL)")
    await db.query("INSERT INTO terminal_profiles VALUES ('profile',7,'installation','mt5',NULL)")
    await db.query("INSERT INTO terminal_account_bindings VALUES (5,'profile','terminal-1',NULL)")
    await db.query("INSERT INTO bridge_refresh_sessions VALUES (1,7,'installation','profile',1,4,NULL)")
    await db.query("INSERT INTO bridge_connection_sessions VALUES ('session',7,5,'profile','terminal-1',1,'v4:connection',NULL,UTC_TIMESTAMP(3))")
    await db.query('INSERT INTO user_trading_account_settings VALUES (7,5,0)')
    await db.query("INSERT INTO trading_projection_revisions VALUES (5,'positions','open',5)")
    await db.query("INSERT INTO trading_projection_provenance_v4 VALUES (5,'positions','open',5,7,'interval',1,'profile','terminal-1',1,UTC_TIMESTAMP(3))")
    const item={accountId:'5',ticket:'101',positionIdentifier:'100',symbol:'XAUUSD',side:'buy',volume:'0.10',revision:5}
    await db.execute('INSERT INTO open_position_snapshots VALUES (5,?,5,?)',['101',JSON.stringify(item)])
    const route={userId:7,accountId:'5',platform:'mt5',brokerServer:'Broker',login:'42',terminalProfileId:'profile',terminalInstanceId:'terminal-1',
      connectionId:'connection',sessionId:'session',connectionEpoch:1,installationId:'installation',credentialGeneration:1,ownershipRevision:'1',timezoneOffsetMinutes:180}
    const scope={route,ticket:'101',positionIdentifier:'100',symbol:'XAUUSD',side:'buy',revision:5,maxAgeMs:30000}
    const reader=createMysqlExecutionPositionReader(db,createTransactionTerminalFactRouteGuard(db))
    await db.beginTransaction()
    try {
      const value=await reader.read(scope)
      assert.ok(value);assert.equal(value.positionIdentifier,'100');assert.equal(value.volume,'0.10')
      const registered=await createPartialCloseWorkflowRegistration(db,route,30000).register(plan)
      assert.equal(registered.replayed,false)
      assert.deepEqual(registered.registration.plan,plan)
      const [[counts]]=await db.query('SELECT COUNT(*) n FROM partial_close_workflow_events_v4 WHERE workflow_id=?',[plan.workflowId])
      assert.equal(Number(counts.n),1)
      checks.push('actual-route-credential-ownership-position-reader-to-registration-in-one-transaction')
    } finally {await db.rollback()}
    for(const [name,sql] of [
      ['owner-revoked',"UPDATE trading_account_ownerships SET revoked_at_utc=UTC_TIMESTAMP(3)"],
      ['ownership-revision-changed','UPDATE trading_accounts SET ownership_revision=2'],
      ['ownership-interval-ended','UPDATE trading_account_ownership_intervals SET ended_at_utc=UTC_TIMESTAMP(3)'],
      ['user-inactive',"UPDATE users SET deletion_status='deleted'"],
      ['membership-expired',"UPDATE users SET plan_expires_at='2020-01-02'"],
      ['credential-revoked','UPDATE bridge_refresh_sessions SET revoked_at=UTC_TIMESTAMP(3)'],
      ['credential-generation-changed','UPDATE bridge_refresh_sessions SET generation=2'],
      ['installation-changed',"UPDATE terminal_profiles SET installation_id='other'"],
      ['binding-changed',"UPDATE terminal_account_bindings SET terminal_instance_id='other'"],
      ['broker-case-changed',"UPDATE trading_accounts SET broker_server='broker'"],
      ['login-changed',"UPDATE trading_accounts SET account_login='042'"],
      ['session-disconnected','UPDATE bridge_connection_sessions SET disconnected_at_utc=UTC_TIMESTAMP(3)'],
      ['connection-replaced',"UPDATE bridge_connection_sessions SET connection_epoch='v4:other'"],
      ['heartbeat-missing','UPDATE bridge_connection_sessions SET last_seen_at_utc=NULL'],
      ['heartbeat-old','UPDATE bridge_connection_sessions SET last_seen_at_utc=UTC_TIMESTAMP(3)-INTERVAL 60 SECOND'],
      ['connection-paused','UPDATE user_trading_account_settings SET connection_paused=1'],
      ['source-interval-changed',"UPDATE trading_projection_provenance_v4 SET ownership_interval_id='old'"],
      ['source-epoch-changed','UPDATE trading_projection_provenance_v4 SET connection_epoch=2'],
      ['source-revision-mixed','UPDATE trading_projection_provenance_v4 SET projection_revision=4'],
      ['source-old','UPDATE trading_projection_provenance_v4 SET observed_at_utc=UTC_TIMESTAMP(3)-INTERVAL 60 SECOND'],
      ['source-future','UPDATE trading_projection_provenance_v4 SET observed_at_utc=UTC_TIMESTAMP(3)+INTERVAL 1 SECOND'],
      ['identifier-missing',"UPDATE open_position_snapshots SET payload_json=JSON_REMOVE(payload_json,'$.positionIdentifier')"],
      ['identifier-changed',"UPDATE open_position_snapshots SET payload_json=JSON_SET(payload_json,'$.positionIdentifier','999')"],
      ['row-ticket-mismatch',"UPDATE open_position_snapshots SET ticket='102'"],
      ['position-account-mismatch',"UPDATE open_position_snapshots SET payload_json=JSON_SET(payload_json,'$.accountId','6')"],
      ['position-revision-mixed','UPDATE open_position_snapshots SET revision=4'],
      ['duplicate-identifier',"INSERT INTO open_position_snapshots VALUES (5,'102',5,JSON_OBJECT('accountId','5','ticket','102','positionIdentifier','100','symbol','XAUUSD','side','buy','volume','0.10','revision',5))"],
    ]) {
      await db.beginTransaction()
      try {
        await db.query(sql)
        assert.equal(await reader.read(scope),null,name)
        await assert.rejects(createPartialCloseWorkflowRegistration(db,route,30000).register(plan),/partial_close_registration_target_mismatch/)
        checks.push(name)
      } finally {await db.rollback()}
    }
    await db.beginTransaction()
    try {
      await assert.rejects(createPartialCloseWorkflowRegistration(db,{...route,connectionEpoch:2},30000).register(plan),/partial_close_registration_target_mismatch/)
      checks.push('parent-command-epoch-must-match-current-target-route')
    } finally {await db.rollback()}
    await db.beginTransaction()
    try {
      await db.query('UPDATE trading_projection_revisions SET revision=6')
      await db.query('UPDATE trading_projection_provenance_v4 SET projection_revision=6,observed_at_utc=UTC_TIMESTAMP(3)')
      await db.query("UPDATE open_position_snapshots SET revision=6,payload_json=JSON_SET(payload_json,'$.revision',6,'$.volume','0.02')")
      const collections=createMysqlExecutionPositionCollectionReader(db,createTransactionTerminalFactRouteGuard(db))
      const projectionReader=createPartialCloseProjectionReader(collections,route,30000)
      const projection=await projectionReader.read(plan)
      assert.ok(projection);assert.equal(projection.revision,6);assert.equal(projection.positions[0].volume,'0.02')
      const input={plan,parentState:'succeeded',history:{parentIntentId:plan.parentIntentId,parentCommandId:plan.parentCommandId,target:{...plan.target},closedVolume:'0.08',completedAt:projection.observedAt-1},projection,now:projection.observedAt+1,maxProjectionAgeMs:30000}
      assert.equal(evaluatePartialCloseProtection(input).state,'risk_review_required')
      assert.equal(await reader.read(scope),null)
      checks.push('actual-current-collection-to-new-revision-protection-eligibility-old-registration-revision-rejected')
      await db.query("UPDATE open_position_snapshots SET payload_json=JSON_SET(payload_json,'$.stopLoss',NULL,'$.takeProfit','9007199254740992.000000000000000001')")
      const protectedCollection=await collections.read({route,maxAgeMs:30000})
      assert.equal(protectedCollection.positions[0].stopLoss,null)
      assert.equal(protectedCollection.positions[0].takeProfit,'9007199254740992.000000000000000001')
      await db.query("UPDATE open_position_snapshots SET payload_json=JSON_SET(JSON_REMOVE(payload_json,'$.stopLoss'),'$.takeProfit','0')")
      const unknownProtection=await collections.read({route,maxAgeMs:30000})
      assert.equal(Object.hasOwn(unknownProtection.positions[0],'stopLoss'),false)
      assert.equal(Object.hasOwn(unknownProtection.positions[0],'takeProfit'),false)
      checks.push('actual-json-protection-preserves-null-and-exact-decimal-while-missing-or-invalid-stays-unknown')
      await db.query('DELETE FROM open_position_snapshots')
      const empty=await projectionReader.read(plan)
      assert.ok(empty);assert.deepEqual(empty.positions,[])
      assert.deepEqual(evaluatePartialCloseProtection({...input,projection:empty}),{state:'stopped',reason:'position_absent'})
      await db.query('DELETE FROM trading_projection_provenance_v4')
      const unavailable=await projectionReader.read(plan)
      assert.equal(unavailable,null)
      assert.deepEqual(evaluatePartialCloseProtection({...input,projection:unavailable}),{state:'wait_projection'})
      checks.push('actual-empty-complete-position-collection-stops-but-missing-provenance-waits')
    } finally {await db.rollback()}
    checks.push(...await verifyPositionProtectionRiskInputs(db))
    checks.push(...await verifyExecutionAccountReference(db,route))
    checks.push(...await verifyPositionProtectionContext(db,route))
    const [[counts]]=await db.query('SELECT COUNT(*) n FROM partial_close_workflows_v4 WHERE id=?',[plan.workflowId])
    assert.equal(Number(counts.n),0)
    return {passed:true,checks,queries:'actual_mysql_authorization_position_and_registration',schema:'minimal_temporary_query_scaffolds',
      foreignKeysVerified:false,realTerminalVerified:false,existingDatabaseWrites:0}
  } finally {
    await db.rollback()
    for(const table of tables.reverse())await db.query(`DROP TEMPORARY TABLE ${table}`)
  }
}
