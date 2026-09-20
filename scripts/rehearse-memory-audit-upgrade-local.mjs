import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import mysql from 'mysql2/promise'
import { hash } from './lib/v4-backfill-contract.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { loadMemoryRuntimeAuditUpgrade } from './lib/memory-runtime-audit-upgrade.mjs'
import { coordinateInplaceSchema } from './lib/inplace-schema-coordinator.mjs'
import { mysqlColumnStore, verifyInplaceJournal, withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { validateColumnHistory } from './lib/dev-vue-column-upgrade.mjs'
import { readAccountRootSnapshot } from './lib/mysql-account-root-snapshot.mjs'
import { readOriginalRows } from './lib/inplace-column-evidence.mjs'
import { tableDefinitionHash } from './lib/inplace-foundation-upgrade.mjs'
const [mode,destination]=process.argv.slice(2)
assert.ok(['--prepare','--inject-start-loss','--inject-ddl-loss','--inject-complete-loss','--resume','--replay'].includes(mode)
  && isAbsolute(destination??'') && process.argv.length===4)
const root=new URL('../',import.meta.url),json=async path=>JSON.parse(await readFile(path,'utf8'))
const restored=await json(new URL('docs/architecture/core-refactor-restored-baseline-20260910.json',root))
assert.equal(restored.target,'dev_vue_m1_source_20260910_01');assert.equal(restored.serverUuid,'ac423207-6ef3-11f1-b302-000c29fda104')
const receiptBytes=await readFile(join(restored.archiveDirectory,'receipt.json'))
assert.equal(sha256(receiptBytes),restored.receiptSha256);assert.equal(JSON.parse(receiptBytes).status,'verified')
const loaded=await loadMemoryRuntimeAuditUpgrade(root),step=loaded.added[0]
const plan={steps:loaded.steps,transitions:loaded.transitions}
const paths=['scripts/rehearse-memory-audit-upgrade-local.mjs','scripts/run-memory-audit-rehearsal-local.py',
  'scripts/lib/memory-runtime-audit-upgrade.mjs','scripts/lib/inplace-schema-coordinator.mjs','scripts/lib/mysql-inplace-column-store.mjs',
  'scripts/lib/dev-vue-column-upgrade.mjs','scripts/lib/mysql-account-root-snapshot.mjs','scripts/lib/inplace-column-evidence.mjs',
  'scripts/lib/inplace-foundation-upgrade.mjs','scripts/lib/v4-backfill-contract.mjs',step.source]
const tools=await Promise.all(paths.map(async path=>({path,sha256:sha256(await readFile(new URL(path,root)))})))
const binding={planHash:hash(plan),tools,referenceHash:loaded.referenceHash,inventoryHash:loaded.inventoryHash,restoredReceiptSha256:restored.receiptSha256}
const baselinePath=join(restored.archiveDirectory,'memory-audit-upgrade-baseline-v1.json')
const output=await open(destination,'wx',0o600)
const report={kind:'memory-audit-restored-upgrade/v1',passed:false,mode,target:restored.target,serverUuid:restored.serverUuid,
  currentDevVueWrites:0,ddlAttempted:0,ddlAcknowledged:0,...binding}
let connection
try {
  const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk)
  const credential=JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.ok(credential.host==='127.0.0.1' && credential.port===13316 && credential.user==='root')
  connection=await mysql.createConnection({...credential,database:restored.target,timezone:'Z',dateStrings:true,jsonStrings:true,supportBigNumbers:true,bigNumberStrings:true,multipleStatements:false})
  await connection.query("SET SESSION time_zone='+00:00'")
  await withInplaceUpgradeLock(connection,restored.target,async()=>{
    const guard=async()=>{
      const [[r]]=await connection.query('SELECT DATABASE() db,@@server_uuid uuid,@@session.time_zone timezone,@@innodb_force_recovery recovery')
      assert.equal(r.db,restored.target);assert.equal(r.uuid,restored.serverUuid);assert.equal(r.timezone,'+00:00');assert.equal(Number(r.recovery),0)
      const [[lock]]=await connection.execute('SELECT IS_USED_LOCK(?) owner,CONNECTION_ID() currentId',[`aurum:inplace:${restored.target}`])
      assert.equal(String(lock.owner),String(lock.currentId))
    }
    const tableHash=async table=>{
      assert.ok(table===step.table || Object.hasOwn(loaded.parentHashes,table) || table==='history_collection_tasks_v4')
      const [[row]]=await connection.query(`SHOW CREATE TABLE ${table}`)
      const [triggers]=await connection.execute('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?',[table])
      assert.equal(triggers.length,0);return tableDefinitionHash(row['Create Table'])
    }
    const snapshot=async()=>{
      await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
      try{return await readAccountRootSnapshot(connection)}finally{await connection.rollback()}
    }
    const journal=mysqlColumnStore(connection,true)
    await guard();assert.ok(await verifyInplaceJournal(connection))
    for(const [table,expected]of Object.entries(loaded.parentHashes))assert.equal(await tableHash(table),expected)
    let baseline
    if(mode==='--prepare'){
      assert.equal(await tableHash(step.table),step.beforeHash)
      const history=await journal.history(),entries=validateColumnHistory(history,loaded.prior.steps)
      assert.ok(loaded.prior.steps.every(s=>entries.get(s.id)?.status==='completed'))
      const previous=await json(new URL('docs/architecture/history-task-restored-replay-20260910.json',root))
      assert.ok(previous.passed && previous.target===restored.target && previous.afterState==='completed' && previous.ddlAttempted===0)
      assert.deepEqual(history,previous.history)
      const before=await snapshot()
      assert.equal(before.tables.length,258)
      assert.equal(hash(before.tables.filter(t=>!['database_upgrade_steps_v4','history_collection_tasks_v4'].includes(t.name))),previous.protectedSnapshotHash)
      assert.equal(await tableHash('history_collection_tasks_v4'),loaded.prior.finalTableHashes.history_collection_tasks_v4)
      baseline={kind:'memory-audit-upgrade-baseline/v1',...binding,target:restored.target,history,snapshot:before.tables,targetMetadata:before.metadata.get(step.table)}
      const file=await open(baselinePath,'wx',0o600)
      try{await file.writeFile(JSON.stringify(baseline,null,2)+'\n');await file.sync()}finally{await file.close()}
    }else baseline=await json(baselinePath)
    assert.equal(baseline.kind,'memory-audit-upgrade-baseline/v1');assert.equal(baseline.target,restored.target)
    for(const key of ['planHash','referenceHash','inventoryHash','restoredReceiptSha256'])assert.equal(baseline[key],binding[key])
    assert.deepEqual(baseline.tools,tools)
    const protectedTables=rows=>rows.filter(t=>![step.table,'database_upgrade_steps_v4'].includes(t.name))
    const verify=async()=>{
      await guard();assert.ok(await verifyInplaceJournal(connection))
      const history=await journal.history();validateColumnHistory(history,loaded.steps)
      assert.deepEqual(history.filter(row=>row.id!==step.id),baseline.history)
      const current=await snapshot()
      assert.equal(hash(protectedTables(current.tables)),hash(protectedTables(baseline.snapshot)),'protected_tables_changed')
      assert.equal(current.tables.find(t=>t.name==='database_upgrade_steps_v4').ddl,baseline.snapshot.find(t=>t.name==='database_upgrade_steps_v4').ddl)
      const [original]=await readOriginalRows(connection,[baseline.targetMetadata])
      const expected=baseline.snapshot.find(t=>t.name===step.table)
      assert.equal(original.rows,expected.rows);assert.equal(original.sha256,expected.rowsSha256,'memory_original_values_changed')
      return current.tables
    }
    await verify()
    const store={history:()=>journal.history(),tableHash,
      async begin(s){await guard();assert.equal(s.checksum,step.checksum);await journal.begin(s);if(mode==='--inject-start-loss')throw Error('injected_ack_loss')},
      async execute(sql){await guard();assert.equal(sql,step.sql);report.ddlAttempted++;await connection.query(sql);report.ddlAcknowledged++;if(mode==='--inject-ddl-loss')throw Error('injected_ack_loss')},
      async complete(s){await guard();assert.equal(s.checksum,step.checksum);await journal.complete(s);if(mode==='--inject-complete-loss')throw Error('injected_ack_loss')}}
    const inspect=async()=>(await coordinateInplaceSchema(store,plan)).steps[0].status
    report.beforeState=await inspect()
    if(mode==='--prepare')assert.equal(report.beforeState,'pending')
    if(mode==='--replay')assert.equal(report.beforeState,'completed')
    if(mode==='--inject-start-loss')assert.ok(report.beforeState==='pending' && !(await journal.history()).some(r=>r.id===step.id))
    if(mode==='--inject-ddl-loss')assert.ok(report.beforeState==='pending' && (await journal.history()).some(r=>r.id===step.id && r.status==='started'))
    if(mode==='--inject-complete-loss')assert.equal(report.beforeState,'reconcile')
    if(mode.startsWith('--inject-')){await assert.rejects(coordinateInplaceSchema(store,plan,{apply:true}),{message:'injected_ack_loss'});report.injectedError='injected_ack_loss'}
    else report.result=await coordinateInplaceSchema(store,plan,{apply:['--resume','--replay'].includes(mode)})
    report.afterState=await inspect()
    const expected={'--inject-start-loss':'pending','--inject-ddl-loss':'reconcile','--inject-complete-loss':'completed','--resume':'completed','--replay':'completed'}[mode]
    if(expected)assert.equal(report.afterState,expected)
    const final=await verify()
    report.history=await journal.history();report.protectedSnapshotHash=hash(protectedTables(final));report.protectedTableCount=protectedTables(final).length
    report.targetRows=final.find(t=>t.name===step.table).rows;report.targetHash=await tableHash(step.table);report.originalTargetValuesUnchanged=true
    if(report.afterState==='completed'){
      const [[r]]=await connection.query(`SELECT COUNT(*) invalid FROM ${step.table} WHERE record_version<>1 OR input_snapshot_id IS NOT NULL OR input_snapshot_sha256 IS NOT NULL OR estimated_token_count IS NOT NULL OR token_estimate_method IS NOT NULL`)
      assert.equal(Number(r.invalid),0)
    }
    report.passed=true
  })
}catch(error){report.error={code:'memory_audit_rehearsal_failed',reason:/^[a-z][a-z0-9_]{2,100}$/.test(error.message??'')?error.message:undefined,trace:error.stack?.split('\n').filter(s=>s.trim().startsWith('at ')).slice(0,4)};process.exitCode=1}
finally{
  if(connection)connection.destroy()
  report.observedAt=new Date().toISOString();await output.writeFile(JSON.stringify(report,null,2)+'\n');await output.sync();await output.close()
  console.log(JSON.stringify({passed:report.passed,mode,beforeState:report.beforeState,afterState:report.afterState,ddlAttempted:report.ddlAttempted,error:report.error}))
}
