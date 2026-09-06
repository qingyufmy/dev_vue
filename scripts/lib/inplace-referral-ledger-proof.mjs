import { readFile } from 'node:fs/promises'
import { sha256 } from './v4-migration-plan.mjs'

export async function verifyReferralLedgerProof(root, proof, backup, columns, plan) {
  const check = (ok, code) => { if (!ok) throw new Error(code) }
  check(proof.kind === 'inplace-referral-ledger-rehearsal/v1' && proof.status === 'verified'
    && proof.database === 'dev_vue_m1_source_20260907_02' && proof.serverUuid === backup.serverUuid
    && proof.backupSnapshotId === backup.sourceSnapshotId && proof.journalCreates === 0
    && plan.steps.length === 47 && proof.ddlExecutions === 1 && proof.repeatNoop === true && proof.sourceDatabaseWritten === false && proof.referralRowsPreserved === 25 && /^[a-f0-9]{64}$/.test(proof.referralHash)
    && proof.originalTables === columns.parity.length && proof.originalRows === backup.parity.rows
    && proof.originalParityHash === sha256(JSON.stringify(columns.parity)), 'inplace_coordinator_proof_invalid')
  const steps = plan.steps.map(({ id, checksum }) => ({ id, checksum }))
  const faults = [46].map(index => plan.steps[index]?.id)
  check(JSON.stringify(proof.steps) === JSON.stringify(steps)
    && JSON.stringify(proof.faults) === JSON.stringify(faults) && JSON.stringify(proof.recoveries) === JSON.stringify(faults)
    && proof.completed?.structureComplete === true && proof.completed?.apply === true
    && proof.repeated?.apply === true && proof.repeated?.structureComplete === true
    && JSON.stringify(proof.repeated.steps) === JSON.stringify(steps.map(({ id }) => ({ id, status: 'completed' }))), 'inplace_coordinator_proof_steps')
  check(Array.isArray(proof.toolManifest) && proof.toolManifest.length === 120, 'inplace_coordinator_proof_manifest')
  const names = new Set()
  for (const file of proof.toolManifest) {
    check(/^[a-zA-Z0-9_./-]+$/.test(file.path) && !file.path.split('/').includes('..')
      && !file.path.startsWith('/') && !names.has(file.path) && /^[a-f0-9]{64}$/.test(file.sha256), 'inplace_coordinator_proof_path')
    names.add(file.path)
    check(sha256(await readFile(new URL(file.path, root))) === file.sha256, 'inplace_coordinator_proof_tools_changed')
  }
  for (const path of ['scripts/lib/inplace-schema-coordinator.mjs', 'scripts/lib/mysql-inplace-column-store.mjs',
    'scripts/lib/inplace-column-evidence.mjs', 'scripts/rehearse-dev-vue-referral-ledger.mjs', 'scripts/lib/inplace-referral-ledger-schema.mjs',
    'server/db/migrations/inplace/011_referral_credit_ledger.sql',
    'server/db/migrations/inplace/001_upgrade_journal.sql']) check(names.has(path), 'inplace_coordinator_proof_manifest')
  return { rehearsalDatabase: proof.database, rehearsalSha256: sha256(JSON.stringify(proof)), toolsVerified: names.size }
}
