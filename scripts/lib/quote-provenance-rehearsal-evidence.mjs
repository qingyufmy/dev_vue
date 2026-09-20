import {join} from 'node:path'
import {tableDefinitionHash} from './inplace-foundation-upgrade.mjs'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {hash} from './v4-backfill-contract.mjs'
import {sha256} from './v4-migration-plan.mjs'

export async function readQuoteProvenanceRehearsalEvidence(root,plan) {
  const reports=[],sources=[]
  for(const [name,ddl] of [['prepare',0],['apply',1],['replay',0]]) {
    const path=`docs/architecture/quote-restored-${name}-20260910.json`,bytes=await readFile(new URL(path,root)),report=JSON.parse(bytes)
    assert.ok(report.passed&&report.kind==='quote-provenance-restored-rehearsal/v1'&&report.target==='dev_vue_m1_source_20260910_02')
    assert.equal(report.serverUuid,'ac423207-6ef3-11f1-b302-000c29fda104');assert.equal(report.currentDevVueWrites,0);assert.equal(report.businessDataWrites,0)
    assert.equal(report.planHash,hash({steps:plan.steps,transitions:plan.transitions}));assert.equal(report.referenceHash,plan.referenceHash)
    assert.equal(report.ddlAttempted,ddl);assert.equal(report.ddlAcknowledged,ddl)
    assert.equal(report.protectedTableCount,269);assert.equal(report.totalTableCount,270)
    assert.equal(report.before,name==='replay'?'completed':'pending');assert.equal(report.after,name==='prepare'?'pending':'completed')
    assert.equal(report.history.length,name==='prepare'?204:205);assert.ok(report.history.every(row=>row.status==='completed'))
    if(reports.length) {
      for(const key of ['tools','receiptSha256','priorEvidenceHash','protectedSnapshotHash','targetRows','targetRowsSha256'])assert.deepEqual(report[key],reports[0][key])
      assert.deepEqual(report.history.filter(row=>row.id!==plan.step.id),reports[0].history)
      assert.equal(report.history.at(-1).id,plan.step.id);assert.equal(report.history.at(-1).checksum,plan.step.checksum)
    }
    sources.push({path,sha256:sha256(bytes)});reports.push(report)
  }
  for(const tool of reports[0].tools)assert.equal(sha256(await readFile(new URL(tool.path,root))),tool.sha256)
  const original=JSON.parse(await readFile(new URL('docs/architecture/inference-restored-baseline-20260910.json',root)))
  const baseline=JSON.parse(await readFile(join(original.archiveDirectory,'quote-provenance-restored-baseline-v1.json')))
  assert.equal(baseline.target,reports[0].target);assert.equal(baseline.planHash,reports[0].planHash);assert.deepEqual(baseline.history,reports[0].history)
  const protectedRows=baseline.snapshot.filter(row=>row.name!=='database_upgrade_steps_v4')
  assert.equal(hash(protectedRows.map(row=>row.name===plan.step.table?{...row,ddl:'reviewed-versioned-constraint'}:row)),reports[0].protectedSnapshotHash)
  assert.equal(tableDefinitionHash(protectedRows.find(row=>row.name===plan.step.table).ddl),plan.step.beforeHash)
  const canonicalProtectedSnapshotHash=hash(protectedRows.map(row=>({name:row.name,rows:row.rows,rowsSha256:row.rowsSha256,
    schemaHash:row.name===plan.step.table?'reviewed-versioned-constraint':tableDefinitionHash(row.ddl)})))
  return {passed:true,target:reports[0].target,serverUuid:reports[0].serverUuid,receiptSha256:reports[0].receiptSha256,
    planHash:reports[0].planHash,canonicalProtectedSnapshotHash,protectedSnapshotHash:reports[0].protectedSnapshotHash,completedSteps:205,tableCount:270,
    targetRows:reports[0].targetRows,targetRowsSha256:reports[0].targetRowsSha256,sources}
}
