import assert from 'node:assert/strict'

/** Caller owns the isolated history reference connection; shadowed tables vanish on cleanup. */
export async function withReferenceObserverSqlFixture(connection, inventory, work) {
  const [[identity]]=await connection.query('SELECT DATABASE() db')
  assert.match(identity.db,/^dev_vue_history_ref_[a-f0-9]{32}$/)
  const {route}=inventory, created=[]
  const definitions={
    users:'id INT PRIMARY KEY,plan VARCHAR(20),plan_expires_at DATETIME(3),token_version INT,deletion_status VARCHAR(20),deleted_at DATETIME(3)',
    observer_channels:'id BIGINT,display_name VARCHAR(64),source_id BIGINT,source_trading_account_id BIGINT,slug VARCHAR(64),active INT,audience VARCHAR(16),revision BIGINT',
    observer_sources:'id BIGINT,trading_account_id BIGINT,analysis_strategy_id BIGINT,revision BIGINT,status VARCHAR(16),configuration_status VARCHAR(16),operator_user_id INT',
    observer_channel_accesses:'observer_channel_id BIGINT,user_id INT,granted_at_utc DATETIME(3),revoked_at_utc DATETIME(3),revision BIGINT',
    trading_accounts:'id BIGINT,ownership_revision BIGINT,deleted_at_utc DATETIME(3),platform VARCHAR(8),account_login VARCHAR(64),broker_server VARCHAR(128),currency VARCHAR(8)',
    trading_account_ownerships:'trading_account_id BIGINT,user_id INT,role VARCHAR(16),revoked_at_utc DATETIME(3),revision BIGINT,interval_id CHAR(36),granted_at_utc DATETIME(3)',
    trading_account_ownership_intervals:'id CHAR(36),user_id INT,trading_account_id BIGINT,role VARCHAR(16),ended_at_utc DATETIME(3),started_at_utc DATETIME(3)',
    terminal_profiles:'id VARCHAR(64),user_id INT,platform VARCHAR(8),deleted_at_utc DATETIME(3)',
    terminal_account_bindings:'trading_account_id BIGINT,terminal_profile_id VARCHAR(64),terminal_instance_id VARCHAR(64),unbound_at_utc DATETIME(3)',
    user_trading_account_settings:'user_id INT,trading_account_id BIGINT,connection_paused INT',
    account_runtime_snapshots:'trading_account_id BIGINT,trade_permission INT',
    trading_projection_revisions:'trading_account_id BIGINT,resource_kind VARCHAR(32),resource_id VARCHAR(32),revision BIGINT',
    trading_projection_provenance_v4:'trading_account_id BIGINT,resource_kind VARCHAR(32),resource_id VARCHAR(32),projection_revision BIGINT,user_id INT,ownership_interval_id VARCHAR(64),ownership_revision BIGINT,terminal_profile_id VARCHAR(64),terminal_instance_id VARCHAR(64),connection_epoch BIGINT,observed_at_utc DATETIME(3)',
    bridge_connection_sessions:'user_id INT,trading_account_id BIGINT,terminal_profile_id VARCHAR(64),terminal_instance_id VARCHAR(64),connection_epoch_v4 BIGINT,connection_epoch VARCHAR(64),disconnected_at_utc DATETIME(3),last_seen_at_utc DATETIME(3)',
    open_position_snapshots:'trading_account_id BIGINT,ticket BIGINT,revision BIGINT,payload_json JSON',
    pending_order_snapshots:'trading_account_id BIGINT,ticket BIGINT,revision BIGINT,payload_json JSON',
  }
  const insert=(table,values)=>{
    assert.ok(Object.hasOwn(definitions,table))
    return connection.execute(`INSERT INTO ${table} VALUES (${values.map(()=>'?').join(',')})`,values)
  }
  try{
    for(const [table,columns] of Object.entries(definitions)){
      await connection.query(`CREATE TEMPORARY TABLE ${table} (${columns}) ENGINE=InnoDB`);created.push(table)
    }
    await insert('users',[route.userId,'pro',null,0,'active',null])
    await insert('observer_channels',[12,'reference',13,route.accountId,'reference',1,'all',1])
    await insert('observer_sources',[13,route.accountId,inventory.analysisStrategyId,1,'active','ready',route.userId])
    await insert('trading_accounts',[route.accountId,route.ownershipRevision,null,route.platform,route.login,route.brokerServer,'USD'])
    await insert('trading_account_ownerships',[route.accountId,route.userId,'owner',null,route.ownershipRevision,'reference-owner','2020-01-01 00:00:00.000'])
    await insert('trading_account_ownership_intervals',['reference-owner',route.userId,route.accountId,'owner',null,'2020-01-01 00:00:00.000'])
    await insert('terminal_profiles',[route.terminalProfileId,route.userId,route.platform,null])
    await insert('terminal_account_bindings',[route.accountId,route.terminalProfileId,route.terminalInstanceId,null])
    await insert('user_trading_account_settings',[route.userId,route.accountId,0])
    await insert('account_runtime_snapshots',[route.accountId,1])
    await insert('bridge_connection_sessions',[route.userId,route.accountId,route.terminalProfileId,route.terminalInstanceId,route.connectionEpoch,`v4:${route.connectionId}`,null,new Date()])
    for(const [kind,collection] of [['positions',inventory.positions],['pending_orders',inventory.pendingOrders]]){
      await insert('trading_projection_revisions',[route.accountId,kind,'open',collection.revision])
      await insert('trading_projection_provenance_v4',[route.accountId,kind,'open',collection.revision,route.userId,'reference-owner',route.ownershipRevision,route.terminalProfileId,route.terminalInstanceId,route.connectionEpoch,new Date(inventory.observedAt)])
      for(const item of collection.items)await insert(kind==='positions'?'open_position_snapshots':'pending_order_snapshots',[route.accountId,item.ticket,collection.revision,JSON.stringify(item)])
    }
    return await work()
  }finally{
    await connection.rollback()
    for(const table of created.reverse())await connection.query(`DROP TEMPORARY TABLE ${table}`)
  }
}
