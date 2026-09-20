import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {open,readFile} from 'node:fs/promises'
import {isAbsolute,join} from 'node:path'
import mysql from 'mysql2/promise'
import {loadQuoteProvenanceUpgrade,coordinateQuoteProvenanceUpgrade} from './lib/quote-provenance-upgrade.mjs'
import {readQuoteProvenanceRehearsalEvidence} from './lib/quote-provenance-rehearsal-evidence.mjs'
import {readInferenceBuildRehearsalEvidence} from './lib/inference-build-rehearsal-evidence.mjs'
import {mysqlColumnStore,verifyInplaceJournal,withInplaceUpgradeLock} from './lib/mysql-inplace-column-store.mjs'
import {validateColumnHistory} from './lib/dev-vue-column-upgrade.mjs'
import {readAccountRootSnapshot} from './lib/mysql-account-root-snapshot.mjs'
import {tableDefinitionHash} from './lib/inplace-foundation-upgrade.mjs'
import {hash} from './lib/v4-backfill-contract.mjs'
import {sha256} from './lib/v4-migration-plan.mjs'

const [mode,destination]=process.argv.slice(2)
assert.ok(['--prepare','--apply','--replay'].includes(mode)&&isAbsolute(destination??'')&&process.argv.length===4)
const root=new URL('../',import.meta.url),target='dev_vue'
const plan=await loadQuoteProvenanceUpgrade(root),priorEvidence=await readInferenceBuildRehearsalEvidence(root,plan.prior)
assert.ok(priorEvidence.passed&&priorEvidence.target==='dev_vue_m1_source_20260910_02'&&priorEvidence.completedSteps===204)
const quoteEvidence=await readQuoteProvenanceRehearsalEvidence(root,plan)
const proofBytes=await readFile(new URL('docs/architecture/inference-restored-baseline-20260910.json',root)),proof=JSON.parse(proofBytes)
assert.ok(proof.passed&&proof.target===priorEvidence.target&&proof.source===target);assert.equal(sha256(proofBytes),priorEvidence.baselineProofSha256)
const receiptBytes=await readFile(join(proof.archiveDirectory,'receipt.json')),receipt=JSON.parse(receiptBytes)
assert.equal(sha256(receiptBytes),priorEvidence.receiptSha256);assert.equal(receipt.status,'verified')
const digest=createHash('sha256');let size=0
for await(const chunk of createReadStream(join(proof.archiveDirectory,'source.sql.enc'))){digest.update(chunk);size+=chunk.length}
assert.equal(size,receipt.artifact.ciphertext.bytes);assert.equal(digest.digest('hex'),receipt.artifact.ciphertext.sha256)
const key=await readFile(join(receipt.keyDirectory,'backup.key'));try{assert.equal(key.length,32)}finally{key.fill(0)}
const paths=['scripts/lib/quote-provenance-rehearsal-evidence.mjs','scripts/apply-quote-provenance-local.mjs','scripts/run-quote-current-local.py','scripts/lib/quote-provenance-upgrade.mjs',
  'scripts/lib/inplace-schema-coordinator.mjs','scripts/lib/mysql-inplace-column-store.mjs','scripts/lib/mysql-account-root-snapshot.mjs',
  'scripts/lib/dev-vue-column-upgrade.mjs','scripts/lib/inplace-column-evidence.mjs','scripts/lib/inplace-foundation-upgrade.mjs',plan.step.source]
const tools=await Promise.all(paths.map(async path=>({path,sha256:sha256(await readFile(new URL(path,root)))})))
const binding={planHash:hash({steps:plan.steps,transitions:plan.transitions}),referenceHash:plan.referenceHash,
  quoteEvidenceHash:hash(quoteEvidence),priorEvidenceHash:hash(priorEvidence),receiptSha256:sha256(receiptBytes),tools}
const baselinePath=join(proof.archiveDirectory,'quote-provenance-current-baseline-v1.json')
const output=await open(destination,'wx',0o600)
const report={kind:'quote-provenance-current-upgrade/v1',passed:false,mode,target,serverUuid:proof.serverUuid,...binding,
  restoredDatabaseWrites:0,businessDataWrites:0,ddlAttempted:0,ddlAcknowledged:0}
let connection
try {
  const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk)
  const credential=JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.ok(credential.host==='127.0.0.1'&&credential.port===13316&&credential.user==='root')
  connection=await mysql.createConnection({...credential,database:target,timezone:'Z',dateStrings:true,jsonStrings:true,supportBigNumbers:true,bigNumberStrings:true,multipleStatements:false})
  await connection.query("SET SESSION time_zone='+00:00'")
  await withInplaceUpgradeLock(connection,target,async()=>{
    const guard=async()=>{
      const [[identity]]=await connection.query('SELECT DATABASE() db,@@server_uuid uuid,@@session.time_zone zone,@@innodb_force_recovery recovery')
      assert.equal(identity.db,target);assert.equal(identity.uuid,proof.serverUuid);assert.equal(identity.zone,'+00:00');assert.equal(Number(identity.recovery),0)
      const [[lock]]=await connection.execute('SELECT IS_USED_LOCK(?) owner,CONNECTION_ID() currentId',['aurum:inplace:'+target]);assert.equal(String(lock.owner),String(lock.currentId))
      const [[clients]]=await connection.query('SELECT COUNT(*) n FROM information_schema.PROCESSLIST WHERE DB=DATABASE() AND ID<>CONNECTION_ID()');assert.equal(Number(clients.n),0,'other_database_clients')
    }
    const snapshot=async()=>{
      await guard();await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
      try{return (await readAccountRootSnapshot(connection)).tables}finally{await connection.rollback()}
    }
    const journal=mysqlColumnStore(connection,true)
    await guard();assert.ok(await verifyInplaceJournal(connection))
    const initial=await snapshot(),history=await journal.history()
    let baseline
    if(mode==='--prepare') {
      validateColumnHistory(history,plan.prior.steps);assert.equal(history.length,204);assert.ok(history.every(row=>row.status==='completed'));assert.equal(initial.length,270)
      const previous=JSON.parse(await readFile(new URL('docs/architecture/inference-current-replay-20260910.json',root)))
      assert.deepEqual(history,previous.history)
      const builds=Object.keys(plan.prior.finalTableHashes)
      const oldBaseline=JSON.parse(await readFile(join(proof.archiveDirectory,'inference-build-current-baseline-v1.json')))
      report.currentDrift=initial.filter(row=>row.name!=='database_upgrade_steps_v4'&&!builds.includes(row.name)).flatMap(row=>{
        const previous=oldBaseline.snapshot.find(item=>item.name===row.name)
        return !previous || hash(previous)!==hash(row)?[{table:row.name,previousRows:previous?.rows,currentRows:row.rows,
          schemaChanged:previous?.ddl!==row.ddl,dataChanged:previous?.rowsSha256!==row.rowsSha256}]:[]
      })
      assert.equal(hash(initial.filter(row=>row.name!=='database_upgrade_steps_v4'&&!builds.includes(row.name))),previous.protectedSnapshotHash)
      for(const name of builds){const row=initial.find(row=>row.name===name);assert.equal(row.rows,0);assert.equal(tableDefinitionHash(row.ddl),plan.prior.finalTableHashes[name])}
      assert.equal(tableDefinitionHash(initial.find(row=>row.name===plan.step.table).ddl),plan.step.beforeHash)
      baseline={kind:'quote-provenance-current-baseline/v1',target,...binding,history,snapshot:initial}
      const file=await open(baselinePath,'wx',0o600);try{await file.writeFile(JSON.stringify(baseline,null,2)+'\n');await file.sync()}finally{await file.close()}
    }else baseline=JSON.parse(await readFile(baselinePath))
    assert.equal(baseline.kind,'quote-provenance-current-baseline/v1');assert.equal(baseline.target,target)
    for(const [key,value]of Object.entries(binding))assert.deepEqual(baseline[key],value)
    const protectedView=rows=>rows.filter(row=>row.name!=='database_upgrade_steps_v4').map(row=>row.name===plan.step.table?{...row,ddl:'reviewed-versioned-constraint'}:row)
    const protectedHash=hash(protectedView(baseline.snapshot))
    const rehearsalParityHash=hash(baseline.snapshot.filter(row=>row.name!=='database_upgrade_steps_v4').map(row=>({
      name:row.name,rows:row.rows,rowsSha256:row.rowsSha256,schemaHash:row.name===plan.step.table?'reviewed-versioned-constraint':tableDefinitionHash(row.ddl)})))
    assert.equal(rehearsalParityHash,quoteEvidence.canonicalProtectedSnapshotHash,'current_and_rehearsed_data_differ')
    report.rehearsalParityHash=rehearsalParityHash
    const verifySnapshot=rows=>{
      assert.equal(rows.length,270);assert.equal(hash(protectedView(rows)),protectedHash,'protected_tables_or_rows_changed')
      assert.equal(rows.find(row=>row.name==='database_upgrade_steps_v4').ddl,baseline.snapshot.find(row=>row.name==='database_upgrade_steps_v4').ddl)
    }
    verifySnapshot(initial)
    const tableHash=async name=>{
      assert.equal(name,plan.step.table);const [triggers]=await connection.execute('SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?',[name]);assert.equal(triggers.length,0)
      return tableDefinitionHash((await connection.query('SHOW CREATE TABLE trading_projection_provenance_v4'))[0][0]['Create Table'])
    }
    const store={history:()=>journal.history(),tableHash,
      async verifyPlan(input){await guard();assert.equal(input.step.checksum,plan.step.checksum);assert.ok(await verifyInplaceJournal(connection))},
      async verifyPrior(rows){assert.deepEqual(rows,baseline.history)},
      async verifyProtected(){verifySnapshot(await snapshot())},
      async begin(step){assert.equal(step.checksum,plan.step.checksum);await journal.begin(step)},
      async execute(sql){assert.equal(sql,plan.step.sql);report.ddlAttempted++;await connection.query(sql);report.ddlAcknowledged++},
      async complete(step){assert.equal(step.checksum,plan.step.checksum);await journal.complete(step)},
    }
    report.before=(await coordinateQuoteProvenanceUpgrade(store,plan)).steps[0].status
    report.result=await coordinateQuoteProvenanceUpgrade(store,plan,{apply:mode!=='--prepare'})
    report.after=(await coordinateQuoteProvenanceUpgrade(store,plan)).steps[0].status
    assert.equal(report.ddlAttempted,mode==='--apply'?1:0);assert.equal(report.ddlAcknowledged,report.ddlAttempted)
    assert.equal(report.after,mode==='--prepare'?'pending':'completed')
    const final=await snapshot();verifySnapshot(final)
    report.history=await journal.history();assert.equal(report.history.length,mode==='--prepare'?204:205)
    report.protectedSnapshotHash=protectedHash;report.protectedTableCount=269;report.totalTableCount=270
    report.targetRows=final.find(row=>row.name===plan.step.table).rows;report.targetRowsSha256=final.find(row=>row.name===plan.step.table).rowsSha256
    report.passed=true
  })
}catch(error){report.error=error.code??error.message??error.name;report.trace=String(error.stack??'').split('\n').filter(line=>line.trim().startsWith('at ')).slice(0,5);process.exitCode=1}
finally{
  if(connection)await connection.end()
  report.observedAt=new Date().toISOString();await output.writeFile(JSON.stringify(report,null,2)+'\n');await output.sync();await output.close()
  console.log(JSON.stringify({passed:report.passed,mode,target,ddlAttempted:report.ddlAttempted,before:report.before,after:report.after,error:report.error}))
}
