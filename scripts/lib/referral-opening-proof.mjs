import { readFile } from 'node:fs/promises'
import { canonical, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { sha256 } from './v4-migration-plan.mjs'

export async function verifyReferralOpeningProof(root, proof, repeat, run, backup, columns) {
  check(proof.kind === 'referral-opening-rehearsal/v1' && proof.status === 'verified'
    && proof.identity.db === 'dev_vue_m1_source_20260907_02' && proof.identity.uuid === backup.serverUuid
    && proof.runManifestHash === hash(run) && run.spec.bindings.snapshotHash === backup.rawSql.sha256
    && proof.insertions === 25 && proof.commitResponseLossInjected === true && proof.repeatInsertions === 0
    && proof.originalRows === backup.parity.rows && proof.originalParityHash === sha256(JSON.stringify(columns.parity))
    && proof.sourceDatabaseWritten === false, 'opening_proof_invalid')
  const result = proof.result
  check(result.inserted === 0 && result.existing === 25 && result.rows === 25 && result.balanceUpdates === 0
    && result.sourceHash === run.bindingManifest.sourceHash && /^[a-f0-9]{64}$/.test(result.openingsHash)
    && canonical(result.migrationAudit) === canonical({ runVerified: true, checkpointsVerified: 1, batchesVerified: 3,
      mappingsVerified: 25, processedRows: 25, databaseWrites: 0 })
    && canonical(proof.repeated) === canonical(result), 'opening_proof_results')
  check(repeat.kind === proof.kind && repeat.status === 'verified' && canonical(repeat.identity) === canonical(proof.identity)
    && repeat.runManifestHash === proof.runManifestHash && repeat.insertions === 0 && repeat.repeatInsertions === 0
    && repeat.commitResponseLossInjected === false && repeat.balanceHash === proof.balanceHash
    && repeat.originalParityHash === proof.originalParityHash && repeat.originalRows === proof.originalRows
    && repeat.sourceDatabaseWritten === false && canonical(repeat.result) === canonical(result)
    && canonical(repeat.repeated) === canonical(result) && canonical(repeat.toolManifest) === canonical(proof.toolManifest), 'opening_proof_repeat')
  check(Array.isArray(proof.toolManifest) && proof.toolManifest.length === 132, 'opening_proof_tools')
  const names = new Set()
  for (const file of proof.toolManifest) {
    check(/^[a-zA-Z0-9_./-]+$/.test(file.path) && !file.path.startsWith('/') && !file.path.split('/').includes('..')
      && !names.has(file.path) && /^[a-f0-9]{64}$/.test(file.sha256), 'opening_proof_path')
    names.add(file.path)
    check(sha256(await readFile(new URL(file.path, root))) === file.sha256, 'opening_proof_tool_changed')
  }
  for (const name of ['scripts/lib/mysql-referral-openings.mjs', 'scripts/lib/v4-referral-opening.mjs',
    'scripts/lib/v4-backfill-mysql-repository.mjs', 'scripts/lib/inplace-referral-ledger-schema.mjs',
    'scripts/rehearse-dev-vue-referral-openings.mjs', 'server/db/migrations/inplace/011_referral_credit_ledger.sql']) {
    check(names.has(name), 'opening_proof_required_tool')
  }
  return { rehearsalSha256: hash(proof), repeatSha256: hash(repeat), toolsVerified: names.size }
}
