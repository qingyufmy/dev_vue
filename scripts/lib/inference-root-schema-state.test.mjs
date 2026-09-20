import {test} from 'node:test'
import assert from 'node:assert/strict'
import {inferenceRootSchemaState,coordinateInferenceRootPromotion} from './inference-root-schema-state.mjs'
const before=[{name:'root',ddl:"CREATE TABLE `root` (\n  `id` int NOT NULL,\n  `label` varchar(100) DEFAULT 'REFERENCES `root`',\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB"},
 {name:'child',ddl:'CREATE TABLE `child` (\n  `root_id` int,\n  CONSTRAINT `fk_root` FOREIGN KEY (`root_id`) REFERENCES `root` (`id`)\n) ENGINE=InnoDB'}]
const after=before.map(row=>({name:row.name==='root'?'retained':row.name,ddl:row.name==='root'?row.ddl.replace('CREATE TABLE `root`','CREATE TABLE `retained`'):row.ddl.replace('REFERENCES `root`','REFERENCES `retained`')}))
const transition={before:inferenceRootSchemaState(before).sha256,after:inferenceRootSchemaState(after).sha256}
const step={id:'rename',checksum:'a'.repeat(64),protocol:'inference-root-promotion/v1',table:'inference_root_schema',
 sql:'RENAME TABLE `root` TO `retained`',beforeHash:transition.before,afterHash:transition.after}
const plan={steps:[step],transitions:[{...transition,step,key:step.table}]}
function fixture(fault){
 let tables=structuredClone(before),rows=[],executions=0,trigger=fault
 const lose=where=>{if(trigger===where){trigger=null;throw new Error('ack_unknown')}}
 const store={async verifyGuard(){},async schemaTables(){return tables},async history(){return rows},
  async begin(){rows=[{id:step.id,checksum:step.checksum,status:'started',startedAt:'2026-09-10T00:00:00Z',completedAt:null}];lose('begin')},
  async execute(){executions++;tables=structuredClone(after);lose('ddl')},
  async complete(){rows[0].status='completed';rows[0].completedAt='2026-09-10T00:00:01Z';lose('complete')}}
 return {store,get executions(){return executions},setTables(value){tables=value}}
}
test('prediction preserves literals and retargets incoming references',()=>{
 assert.deepEqual(inferenceRootSchemaState(before,[{from:'root',to:'retained'}]),inferenceRootSchemaState(after))
})
for(const fault of ['begin','ddl','complete'])test(fault+' acknowledgement loss resumes without duplicate DDL',async()=>{
 const f=fixture(fault)
 await assert.rejects(coordinateInferenceRootPromotion(f.store,plan,{apply:true}),/ack_unknown/)
 const result=await coordinateInferenceRootPromotion(f.store,plan,{apply:true})
 assert.equal(result.structureComplete,true);assert.equal(f.executions,1)
 await coordinateInferenceRootPromotion(f.store,plan,{apply:true});assert.equal(f.executions,1)
})
test('missing incoming table fails before any DDL',async()=>{
 const f=fixture();f.setTables([before[0]])
 await assert.rejects(coordinateInferenceRootPromotion(f.store,plan,{apply:true}),/schema_conflict/)
 assert.equal(f.executions,0)
})
test('altered incoming foreign key fails instead of accepting promoted root alone',async()=>{
 const f=fixture('ddl');await assert.rejects(coordinateInferenceRootPromotion(f.store,plan,{apply:true}),/ack_unknown/)
 f.setTables([after[0],before[1]])
 await assert.rejects(coordinateInferenceRootPromotion(f.store,plan,{apply:true}),/schema_conflict/)
 assert.equal(f.executions,1)
})
