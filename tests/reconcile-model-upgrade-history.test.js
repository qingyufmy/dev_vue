import {describe,it,expect} from 'vitest'
import {reconcileModelUpgradeHistory} from '../scripts/lib/reconcile-model-upgrade-history.mjs'
function fixture({wrong=false,busy=false,status='reconciliation_required',failReceipt=false,failInsert=false,failCommit=false}={}) {
 const log=[];let inserts=0
 const db={async query(sql){log.push(sql);return [[{db:wrong?'other':'dev',uuid:'uuid'}]]},async execute(sql,args){log.push(sql);if(sql.includes('GET_LOCK'))return [[{acquired:busy?0:1}]];if(sql.startsWith('INSERT')){if(failInsert&&++inserts===2)throw Error('sql detail secret');return [{affectedRows:1}]};return [[]]},async beginTransaction(){log.push('begin')},async rollback(){log.push('rollback')},async commit(){log.push('commit');if(failCommit)throw Error('network secret')}}
 const inspect=async()=>({identity:{db:'dev',uuid:'uuid'},journal:'available',steps:[{id:'inplace_081_01_market_source_selections',status:'completed'},...['inplace_082_01_model_configuration_receipts','inplace_083_01_model_assignments'].map(id=>({id,status,checksum:'hash'}))]})
 const evidence=async phase=>{log.push(phase);if(failReceipt)throw Error('disk full')}
 return {log,run:()=>reconcileModelUpgradeHistory(db,[],{database:'dev',serverUuid:'uuid'},evidence,inspect)}
}
describe('model history reconciliation',()=>{
 it('writes exactly two existing ledger rows after durable evidence, without DDL',async()=>{
  const f=fixture();expect((await f.run()).registered).toHaveLength(2)
  const writes=f.log.filter(q=>q.startsWith('INSERT'));expect(writes).toHaveLength(2)
  expect(f.log.indexOf('prepared')).toBeLessThan(f.log.indexOf(writes[0]));expect(f.log.indexOf('commit')).toBeLessThan(f.log.indexOf('committed'))
  expect(f.log.some(q=>/^(CREATE|ALTER|UPDATE|DELETE|DROP) /.test(q))).toBe(false)
 })
 it('replay preserves completed history without inserts',async()=>{const f=fixture({status:'completed'});expect((await f.run()).status).toBe('already_registered');expect(f.log.some(q=>q.startsWith('INSERT'))).toBe(false)})
 it.each([{wrong:true},{busy:true},{status:'schema_conflict'},{status:'recovery_required'},{failReceipt:true}])('fails before writes for %j',async options=>{const f=fixture(options);await expect(f.run()).rejects.toThrow();expect(f.log.some(q=>q.startsWith('INSERT'))).toBe(false)})
 it('rolls back both registrations when the second insert fails',async()=>{const f=fixture({failInsert:true});await expect(f.run()).rejects.toThrow();expect(f.log).toContain('rollback');expect(f.log).not.toContain('commit')})
 it('marks uncertain commit as requiring inspection',async()=>{const f=fixture({failCommit:true});await expect(f.run()).rejects.toThrow('reconciliation_outcome_requires_inspection');expect(f.log).not.toContain('committed')})
})
