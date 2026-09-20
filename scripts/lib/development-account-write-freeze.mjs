import assert from 'node:assert/strict'

/** Development-only: prevent app reconnects, require drained sessions, restore original account lock state. */
export async function withDevelopmentAccountWriteFreeze(db,work){
 const [[identity]]=await db.query('SELECT DATABASE() db,@@server_uuid uuid,CURRENT_USER() currentUser')
 assert.equal(identity.db,'dev_vue');assert.equal(identity.uuid,'ac423207-6ef3-11f1-b302-000c29fda104')
 assert.ok(identity.currentUser.startsWith('root@'))
 const [accounts]=await db.query("SELECT User user,Host host,account_locked locked FROM mysql.user WHERE User='dev_vue' ORDER BY Host")
 assert.ok(accounts.length>0)
 const [grants]=await db.query("SELECT Db db FROM mysql.db WHERE User='dev_vue'")
 assert.ok(grants.length>0 && grants.every(row=>row.db==='dev_vue'),'development_account_shared_database')
 for(const account of accounts){assert.equal(account.user,'dev_vue');assert.match(account.host,/^[a-zA-Z0-9_.:%/-]+$/);assert.ok(['Y','N'].includes(account.locked))}
 const changed=[]
 const sql=(account,action)=>"ALTER USER 'dev_vue'@'"+account.host+"' ACCOUNT "+action
 const assertHeld=async()=>{
  const [actual]=await db.query("SELECT Host host,account_locked locked FROM mysql.user WHERE User='dev_vue' ORDER BY Host")
  assert.deepEqual(actual.map(row=>row.host),accounts.map(row=>row.host));assert.ok(actual.every(row=>row.locked==='Y'),'development_account_lock_lost')
  const [clients]=await db.query("SELECT ID id FROM information_schema.PROCESSLIST WHERE ID<>CONNECTION_ID() AND (DB='dev_vue' OR USER='dev_vue')")
  assert.equal(clients.length,0,'development_database_clients_not_drained')
 }
 try{
  for(const account of accounts)if(account.locked==='N'){
   // Track before issuing ALTER: an acknowledgement may be lost after it takes effect.
   changed.push(account);await db.query(sql(account,'LOCK'))
  }
  await assertHeld()
  return await work({assertHeld,accountCount:accounts.length})
 }finally{
  const failures=[]
  for(const account of changed){try{await db.query(sql(account,'UNLOCK'))}catch{failures.push(account.host)}}
  if(failures.length)throw Error('development_account_unlock_failed')
  const [restored]=await db.query("SELECT Host host,account_locked locked FROM mysql.user WHERE User='dev_vue' ORDER BY Host")
  assert.deepEqual(restored.map(row=>({host:row.host,locked:row.locked})),accounts.map(row=>({host:row.host,locked:row.locked})),'development_account_lock_restore_mismatch')
 }
}
