import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { inferenceBuildNames,inferenceBuildMapping,inferenceBuildDefinition,inferenceBuildObservedHash,inferenceBuildPhases } from './inference-build-schema.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'
export async function verifyInferenceBuildReference(connection,strategyId,versionId){
  const [[identity]]=await connection.query('SELECT DATABASE() db')
  assert.match(identity.db,/^dev_vue_strategy_ref_[a-f0-9]{32}$/)
  const tables=[]
  for(const name of inferenceBuildNames){
    const [[original]]=await connection.query(`SHOW CREATE TABLE ${name}`)
    tables.push({name,buildName:inferenceBuildMapping[name],sourceDdl:original['Create Table'],buildSql:inferenceBuildDefinition(name,original['Create Table'])})
  }
  const phases=inferenceBuildPhases(tables.map(row=>({name:row.name,sql:row.buildSql})))
  const transitions=[],states=new Map()
  for(const entry of [...phases.creates,...phases.deferred]){
    await connection.query(entry.sql)
    const [[ddl]]=await connection.query(`SHOW CREATE TABLE ${entry.table}`)
    const afterHash=tableDefinitionHash(ddl['Create Table'])
    transitions.push({...entry,beforeHash:states.get(entry.table)??null,afterHash,ddl:ddl['Create Table']})
    states.set(entry.table,afterHash)
  }
  assert.equal(phases.deferred.length,1)
  for(const table of tables){
    const [[observed]]=await connection.query(`SHOW CREATE TABLE ${table.buildName}`)
    assert.equal(inferenceBuildObservedHash(observed['Create Table'],table.buildSql),tableDefinitionHash(table.buildSql))
    table.observedDdl=observed['Create Table'];table.observedHash=tableDefinitionHash(observed['Create Table'])
  }
  const [links]=await connection.query(`SELECT TABLE_NAME tableName,CONSTRAINT_NAME name,COLUMN_NAME columnName,REFERENCED_TABLE_NAME parent,REFERENCED_COLUMN_NAME parentColumn
    FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (${inferenceBuildNames.map(()=>'?').join(',')}) AND REFERENCED_TABLE_NAME IS NOT NULL
    ORDER BY TABLE_NAME,CONSTRAINT_NAME,ORDINAL_POSITION`,inferenceBuildNames.map(name=>inferenceBuildMapping[name]))
  assert.ok(links.some(r=>r.tableName==='ai_model_tasks_v4_build' && r.parent==='inference_snapshots_v4_build'))
  assert.ok(links.some(r=>r.tableName==='ai_trader_runs_v4_build' && r.parent==='strategy_subscriptions_v4_build'))
  assert.ok(links.some(r=>r.tableName==='risk_decisions_v4_build' && r.parent==='trade_decisions_v4_build'))
  assert.ok(links.some(r=>r.tableName==='trade_decisions_v4_build' && r.parent==='risk_decisions_v4_build'))
  assert.ok(!links.some(r=>inferenceBuildNames.includes(r.parent)||r.parent==='strategy_subscriptions'))
  const parentRequirements=[]
  const visited=new Set(),buildNames=new Set(inferenceBuildNames.map(name=>inferenceBuildMapping[name]))
  for(const link of links){
    const key=`${link.parent}.${link.parentColumn}`
    if(buildNames.has(link.parent)||visited.has(key))continue
    visited.add(key)
    const [[column]]=await connection.execute('SELECT COLUMN_TYPE type,IS_NULLABLE nullable,COLLATION_NAME collation FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?',[link.parent,link.parentColumn])
    assert.ok(column);parentRequirements.push({table:link.parent,column:link.parentColumn,...column})
  }
  const snapshot=randomUUID(),task=randomUUID(),now='2026-09-10 00:00:00.000'
  await connection.beginTransaction()
  try{
    await connection.execute(`INSERT INTO inference_snapshots_v4_build
      (id,purpose,user_id,strategy_id,strategy_version_id,standard_symbol,payload_sha256,payload_bytes,captured_at_utc,created_at_utc)
      VALUES (?,'analysis',7,?,?,'XAUUSD',?,2,?,?)`,[snapshot,strategyId,versionId,'a'.repeat(64),now,now])
    const insert=`INSERT INTO ai_model_tasks_v4_build
      (id,purpose,user_id,input_snapshot_id,status,deadline_at_utc,fencing_token,created_at_utc,updated_at_utc)
      VALUES (?,'analysis',7,?,'queued',?,1,?,?)`
    await connection.execute(insert,[task,snapshot,now,now,now])
    await assert.rejects(connection.execute(insert,[randomUUID(),randomUUID(),now,now,now]),{code:'ER_NO_REFERENCED_ROW_2'})
  }finally{await connection.rollback()}
  for(const name of inferenceBuildNames){const [[count]]=await connection.query(`SELECT COUNT(*) n FROM ${inferenceBuildMapping[name]}`);assert.equal(Number(count.n),0)}
  return {passed:true,tables,phases,transitions,parentRequirements,foreignKeys:links,checks:['twelve-isolated-build-tables-with-unaltered-constraints','snapshot-and-subscription-foreign-keys-target-build-names',
    'real-build-snapshot-task-link-and-missing-parent-rejection','fixture-transaction-rolled-back'],parentEvidence:'scaffold-users-account-and-existing-reference-strategy-subscription-risk-parents',existingDatabaseWrites:0}
}
