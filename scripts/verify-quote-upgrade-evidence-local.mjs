import assert from 'node:assert/strict'
import {readFile,open} from 'node:fs/promises'
import {isAbsolute} from 'node:path'
import {loadQuoteProvenanceUpgrade} from './lib/quote-provenance-upgrade.mjs'
import {readQuoteProvenanceRehearsalEvidence} from './lib/quote-provenance-rehearsal-evidence.mjs'
import {sha256} from './lib/v4-migration-plan.mjs'
import {hash} from './lib/v4-backfill-contract.mjs'
const [destination]=process.argv.slice(2);assert.ok(isAbsolute(destination??'')&&process.argv.length===3)
const root=new URL('../',import.meta.url),plan=await loadQuoteProvenanceUpgrade(root),rehearsal=await readQuoteProvenanceRehearsalEvidence(root,plan)
const sources=[],reports=[]
for(const [name,ddl] of [['prepare',0],['apply',1],['replay',0]]) {
  const path=`docs/architecture/quote-current-${name}-v4-20260910.json`,bytes=await readFile(new URL(path,root)),report=JSON.parse(bytes)
  assert.ok(report.passed&&report.kind==='quote-provenance-current-upgrade/v1'&&report.target==='dev_vue')
  assert.equal(report.serverUuid,rehearsal.serverUuid);assert.equal(report.restoredDatabaseWrites,0);assert.equal(report.businessDataWrites,0)
  assert.equal(report.ddlAttempted,ddl);assert.equal(report.ddlAcknowledged,ddl)
  assert.equal(report.planHash,rehearsal.planHash);assert.equal(report.quoteEvidenceHash,hash(rehearsal));assert.equal(report.receiptSha256,rehearsal.receiptSha256)
  assert.equal(report.rehearsalParityHash,rehearsal.canonicalProtectedSnapshotHash);assert.equal(report.protectedTableCount,269);assert.equal(report.totalTableCount,270)
  assert.equal(report.targetRows,rehearsal.targetRows);assert.equal(report.targetRowsSha256,rehearsal.targetRowsSha256)
  assert.equal(report.before,name==='replay'?'completed':'pending');assert.equal(report.after,name==='prepare'?'pending':'completed')
  assert.equal(report.history.length,name==='prepare'?204:205);assert.ok(report.history.every(row=>row.status==='completed'))
  if(reports.length) {
    assert.deepEqual(report.tools,reports[0].tools);assert.equal(report.protectedSnapshotHash,reports[0].protectedSnapshotHash)
    assert.deepEqual(report.history.filter(row=>row.id!==plan.step.id),reports[0].history)
    assert.equal(report.history.at(-1).id,plan.step.id);assert.equal(report.history.at(-1).checksum,plan.step.checksum)
  }
  sources.push({path,sha256:sha256(bytes)});reports.push(report)
}
for(const tool of reports[0].tools)assert.equal(sha256(await readFile(new URL(tool.path,root))),tool.sha256)
const proof={kind:'quote-provenance-current-proof/v1',passed:true,target:'dev_vue',serverUuid:rehearsal.serverUuid,
  planHash:rehearsal.planHash,receiptSha256:rehearsal.receiptSha256,sources,rehearsalSources:rehearsal.sources,
  completedSteps:205,startedSteps:0,tableCount:270,protectedTableCount:269,protectedSnapshotHash:reports[0].protectedSnapshotHash,rehearsalParityHash:rehearsal.canonicalProtectedSnapshotHash,
  targetRows:rehearsal.targetRows,targetRowsSha256:rehearsal.targetRowsSha256,ddlApplied:1,replayDdl:0,priorHistoryUnchanged:true,businessDataWrites:0,
  executionCapabilityEnabled:false,observedAt:new Date().toISOString()}
const file=await open(destination,'wx',0o600);try{await file.writeFile(JSON.stringify(proof,null,2)+'\n');await file.sync()}finally{await file.close()}
console.log(JSON.stringify({passed:true,completedSteps:205,tableCount:270,protectedTableCount:269,ddlApplied:1,replayDdl:0}))
