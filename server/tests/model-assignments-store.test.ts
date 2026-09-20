import {expect,it,vi} from 'vitest'
import type {Pool} from 'mysql2/promise'
import {createModelAssignments} from '../src/modules/inference/infrastructure/mysql-model-assignments.js'
function fixture(available=true){let state:any=null;const receipts:any[]=[];const writes:any[]=[]
 const c={beginTransaction:vi.fn(),commit:vi.fn(),rollback:vi.fn(),release:vi.fn(),execute:vi.fn(async(sql:string,args:any[])=>{
  if(sql.startsWith('SELECT id FROM users'))return [[{id:7}],[]]
  if(sql.startsWith('SELECT request_sha256'))return [receipts.filter(r=>r.key===args[1]),[]]
  if(sql.startsWith('SELECT CAST(analysis'))return [state?[state]:[],[]]
  if(sql.startsWith('SELECT p.id'))return [available?[{id:3}]:[],[]]
  writes.push({sql,args});if(sql.startsWith('INSERT INTO user_model_assignments'))state={analysis:args[1],trader:args[2],review:args[3],revision:args[4]}
  if(sql.startsWith('INSERT INTO model_configuration_receipts'))receipts.push({key:args[1],request_sha256:args[2],result_json:args[3]})
  return [{affectedRows:1},[]]
 })};return {service:createModelAssignments({getConnection:async()=>c} as unknown as Pool),writes,c}}
it('saves all purposes atomically, replays the same request and detects stale updates',async()=>{
 const f=fixture();expect(await f.service.read(7)).toEqual({analysis:null,trader:null,review:null,revision:'0'})
 const change={analysis:'3',trader:'3',review:null,revision:'0'}
 expect(await f.service.save(7,'assignment-request-1',change)).toEqual({...change,revision:'1'})
 const count=f.writes.length;expect(await f.service.save(7,'assignment-request-1',change)).toEqual({...change,revision:'1'});expect(f.writes).toHaveLength(count)
 await expect(f.service.save(7,'assignment-request-2',change)).rejects.toMatchObject({status:409})
 expect(f.writes).toHaveLength(count)
 await f.service.save(7,'assignment-request-3',{analysis:null,trader:null,review:null,revision:'1'})
 expect((await f.service.read(7)).analysis).toBe(null)
})
it('rejects models that are unavailable or not owned/shared',async()=>{
 const f=fixture(false);await expect(f.service.save(7,'assignment-request-1',{analysis:'99',trader:null,review:null,revision:'0'})).rejects.toMatchObject({code:'model_selection_unavailable'})
 expect(f.writes).toHaveLength(0);expect(f.c.rollback).toHaveBeenCalled()
})
