import assert from 'node:assert/strict'
import {inferenceBuildNames,inferenceBuildMapping} from './inference-build-schema.mjs'
import {tableDefinitionHash} from './inplace-foundation-upgrade.mjs'

/** A DDL candidate only. Callers must rehearse data retention and separately admit runtime data. */
export function planInferenceRootPromotion(inventory,expectedBuildHashes){
 assert.ok(inventory.passed && inventory.writes===0 && inventory.completedSteps===205)
 assert.equal(inventory.identity?.db,'dev_vue')
 assert.equal(inventory.identity?.uuid,'ac423207-6ef3-11f1-b302-000c29fda104')
 const renames=[],retained=[]
 for(const name of inferenceBuildNames){
  const build=inferenceBuildMapping[name],source=inventory.tables[build],current=inventory.tables[name]
  const legacy=name+'_legacy_v3'
  assert.ok(source?.exists && current && inventory.tables[legacy]?.exists===false,'promotion_inventory_incomplete_or_legacy_occupied')
  assert.equal(source.rows,'0','promotion_build_has_data_requiring_review')
  assert.equal(source.sha256,tableDefinitionHash(source.ddl))
  assert.equal(source.sha256,expectedBuildHashes[build],'promotion_build_schema_drift')
  if(current.exists){
   assert.equal(current.sha256,tableDefinitionHash(current.ddl))
   renames.push({from:name,to:legacy})
   retained.push({from:name,to:legacy,rows:current.rows,sha256:current.sha256,
    incomingForeignKeys:inventory.foreignKeys.filter(row=>row.parent===name)})
  }
  renames.push({from:build,to:name})
 }
 for(const {from,to} of renames){assert.match(from,/^[a-z][a-z0-9_]*$/);assert.match(to,/^[a-z][a-z0-9_]*$/)}
 return {kind:'inference-root-promotion-candidate/v1',renames,retained,
  sql:'RENAME TABLE '+renames.map(({from,to})=>'`'+from+'` TO `'+to+'`').join(', '),
  writes:0,executed:false,runtimeReady:false,dataMigrationComplete:false,
  requires:['complete-source-DDL-rehearsal','preserved-rows-and-incoming-foreign-keys-proof',
   'subscription-root-promotion-and-business-backfill','durable-upgrade-journal-and-ack-loss-recovery']}
}
