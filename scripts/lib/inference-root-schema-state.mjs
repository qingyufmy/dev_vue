import assert from 'node:assert/strict'
import {tableDefinitionHash} from './inplace-foundation-upgrade.mjs'
import {hash} from './v4-backfill-contract.mjs'
import {coordinateInplaceSchema} from './inplace-schema-coordinator.mjs'

/** Include the entire schema so incoming foreign keys cannot be omitted from admission. */
export function inferenceRootSchemaState(tables,renames=[]){
 assert.ok(Array.isArray(tables)&&tables.length>0)
 const mapping=new Map(renames.map(({from,to})=>[from,to]))
 assert.equal(mapping.size,renames.length)
 for(const {from,to} of renames){assert.match(from,/^[a-z][a-z0-9_]*$/);assert.match(to,/^[a-z][a-z0-9_]*$/)
  assert.ok(tables.some(row=>row.name===from),'promotion_source_missing')}
 const definitions=tables.map(({name,ddl})=>{
  assert.match(name,/^[a-z][a-z0-9_]*$/);assert.ok(ddl.startsWith('CREATE TABLE `'+name+'` ('))
  // Preserve literals, comments, column names and constraint names; change structural identifiers only.
  const rewritten=ddl.replace(/'(?:\\.|''|[^'\\])*'|"(?:\\.|""|[^"\\])*"|\/\*[\s\S]*?\*\/|--[^\r\n]*|#[^\r\n]*|(CREATE TABLE |REFERENCES )`([a-z][a-z0-9_]*)`|`(?:``|[^`])*`/g,
   (full,prefix,identifier)=>prefix&&mapping.has(identifier)?prefix+'`'+mapping.get(identifier)+'`':full)
  return {name:mapping.get(name)??name,sha256:tableDefinitionHash(rewritten)}
 }).sort((a,b)=>a.name.localeCompare(b.name))
 assert.equal(new Set(definitions.map(row=>row.name)).size,definitions.length,'promotion_target_collision')
 return {definitions,sha256:hash(definitions)}
}

/** Uses the existing durable coordinator; callers provide verified schema/journal, lock and backup guards. */
export async function coordinateInferenceRootPromotion(store,plan,options={}){
 assert.equal(plan.transitions.length,1)
 const {step,before,after}=plan.transitions[0]
 assert.equal(step.protocol,'inference-root-promotion/v1')
 assert.equal(step.beforeHash,before);assert.equal(step.afterHash,after)
 const adapter={...store,async tableHash(key){
  assert.equal(key,step.table)
  await store.verifyGuard()
  return inferenceRootSchemaState(await store.schemaTables()).sha256
 },async execute(sql){
  assert.equal(sql,step.sql);await store.verifyGuard();await store.execute(sql)
 }}
 await store.verifyGuard()
 return coordinateInplaceSchema(adapter,plan,options)
}
