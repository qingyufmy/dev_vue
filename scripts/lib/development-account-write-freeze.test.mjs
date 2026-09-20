import {test} from 'node:test'
import assert from 'node:assert/strict'
import {withDevelopmentAccountWriteFreeze} from './development-account-write-freeze.mjs'
function fixture({busy=false,ackLoss=false}={}){
 const accounts=[{user:'dev_vue',host:'%',locked:'N'},{user:'dev_vue',host:'localhost',locked:'Y'}],statements=[]
 return {accounts,statements,db:{async query(sql){
  if(sql.startsWith('SELECT DATABASE'))return [[{db:'dev_vue',uuid:'ac423207-6ef3-11f1-b302-000c29fda104',currentUser:'root@localhost'}]]
  if(sql.includes('FROM mysql.db'))return [[{db:'dev_vue'}]]
  if(sql.includes('FROM mysql.user'))return [accounts.map(row=>({...row}))]
  if(sql.includes('PROCESSLIST'))return [busy?[{id:42}]:[]]
  statements.push(sql)
  const row=accounts.find(row=>sql.includes("@'"+row.host+"'"));row.locked=sql.endsWith('UNLOCK')?'N':'Y'
  if(ackLoss&&sql.endsWith(' LOCK')){ackLoss=false;throw Error('ack_lost')}
  return [{}]
 }}}
}
test('locks only previously unlocked accounts and restores both states',async()=>{
 const f=fixture();let called=false
 await withDevelopmentAccountWriteFreeze(f.db,async guard=>{await guard.assertHeld();called=true})
 assert.ok(called);assert.deepEqual(f.accounts.map(row=>row.locked),['N','Y']);assert.equal(f.statements.length,2)
})
test('existing clients prevent work and restore locks',async()=>{
 const f=fixture({busy:true});await assert.rejects(withDevelopmentAccountWriteFreeze(f.db,()=>assert.fail('must not run')),/clients_not_drained/)
 assert.deepEqual(f.accounts.map(row=>row.locked),['N','Y'])
})
test('lost lock acknowledgement still restores application access',async()=>{
 const f=fixture({ackLoss:true});await assert.rejects(withDevelopmentAccountWriteFreeze(f.db,()=>assert.fail('must not run')),/ack_lost/)
 assert.deepEqual(f.accounts.map(row=>row.locked),['N','Y'])
})
test('failed upgrade restores account access',async()=>{
 const f=fixture();await assert.rejects(withDevelopmentAccountWriteFreeze(f.db,async()=>{throw Error('upgrade_failed')}),/upgrade_failed/)
 assert.deepEqual(f.accounts.map(row=>row.locked),['N','Y'])
})
