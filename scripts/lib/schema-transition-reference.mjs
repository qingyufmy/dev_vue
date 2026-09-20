import assert from 'node:assert/strict'
import {inferenceRootSchemaState} from './inference-root-schema-state.mjs'

/** Records actual full-schema transitions in an owned empty reference database only. */
export async function createSchemaTransitionReference(db){
 const [[identity]]=await db.query('SELECT DATABASE() db')
 assert.match(identity.db,/^dev_vue_workflow_schema_ref_[a-f0-9]{32}$/)
 const read=async()=>{
  const [names]=await db.query("SELECT TABLE_NAME name FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' ORDER BY TABLE_NAME")
  const tables=[]
  for(const {name} of names){assert.match(name,/^[a-z][a-z0-9_]*$/)
   const [[row]]=await db.query('SHOW CREATE TABLE `'+name+'`');tables.push({name,ddl:row['Create Table']})}
  return inferenceRootSchemaState(tables)
 }
 let state=await read()
 const initial=state,transitions=[]
 return {initial,transitions,connection:{
  execute:(...args)=>db.execute(...args),
  async query(sql,...args){
   if(!/^(?:CREATE|ALTER|RENAME) TABLE\b/.test(sql))return db.query(sql,...args)
   assert.equal(args.length,0)
   const before=await read();assert.equal(before.sha256,state.sha256,'reference_schema_changed_between_steps')
   const result=await db.query(sql)
   const after=await read();assert.notEqual(after.sha256,before.sha256,'reference_DDL_has_no_structural_effect')
   const old=new Map(before.definitions.map(row=>[row.name,row.sha256]))
   const changed=after.definitions.filter(row=>old.get(row.name)!==row.sha256)
   const remaining=new Set(after.definitions.map(row=>row.name))
   const removed=before.definitions.filter(row=>!remaining.has(row.name)).map(row=>row.name)
   transitions.push({ordinal:transitions.length+1,sql,beforeHash:before.sha256,afterHash:after.sha256,changed,removed})
   state=after;return result
  }
 }}
}
