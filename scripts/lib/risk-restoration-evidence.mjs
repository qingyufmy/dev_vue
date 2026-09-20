import { hash } from './v4-backfill-contract.mjs'
import { sha256 } from './v4-migration-plan.mjs'
import { validateColumnHistory } from './dev-vue-column-upgrade.mjs'
import { verifyRiskRestoredSnapshot } from './risk-backup-parity.mjs'
import { legacyCandlePromotionSnapshot } from './legacy-candle-promotion.mjs'

const check = (value, code) => { if (!value) throw Error('risk_restoration_evidence_' + code) }

// Historical evidence only: execution tools retain their recorded versions.
// This does not certify the current upgrade implementation or target state.
export function verifyRiskRehearsalChain(plan, baseline, reference, reports) {
  const registryHash = hash(plan.steps.map(({ id, checksum }) => ({ id, checksum })))
  check(baseline.kind === 'risk-restored-baseline/v1' && baseline.passed === true
    && baseline.registrySteps === plan.prior.steps.length && baseline.riskTargetsAbsent === true
    && baseline.currentDevVueWrites === 0 && baseline.restoredWrites === 0, 'baseline')
  check(baseline.sourceIdentity.database === 'dev_vue'
    && baseline.restoredIdentity.database !== baseline.sourceIdentity.database
    && baseline.restoredIdentity.serverUuid === baseline.sourceIdentity.serverUuid
    && hash(reference.identity) === hash(baseline.sourceIdentity)
    && reference.registryHash === registryHash, 'identity_registry')
  check(Array.isArray(reports) && reports.length === 4, 'reports')
  const modes = ['--inject-create-loss', '--inject-alter-loss', '--resume', '--resume']
  const lengths = [plan.prior.steps.length + 1, plan.prior.steps.length + 3, plan.steps.length, plan.steps.length]
  const counts = [1, 2, 5, 0]
  for (const [index, report] of reports.entries()) {
    check(report.kind === 'risk-structure-rehearsal/v1' && report.passed === true
      && report.sourceWrites === 0 && report.mode === modes[index] && report.ddlCount === counts[index]
      && hash(report.identity) === hash(baseline.restoredIdentity), 'report')
    check(report.baselineHash === hash(baseline) && report.referenceHash === hash(reference)
      && hash(report.tools) === hash(reference.tools)
      && report.protectedSnapshotHash === baseline.restoredSnapshotHash, 'binding')
    validateColumnHistory(report.history, plan.steps)
    check(report.history.length === lengths[index], 'history_length')
    const prior = report.history.slice(0, plan.prior.steps.length)
    check(prior.every(row => row.status === 'completed')
      && hash(prior) === baseline.sourceHistoryHash && hash(prior) === baseline.restoredHistoryHash, 'prior_history')
    if (index < 2) {
      const step = plan.additions[index === 0 ? 0 : 2]
      check(report.result.status === 'ddl-unknown-injected' && report.result.next === step.id
        && report.history.at(-1).id === step.id && report.history.at(-1).status === 'started'
        && report.history.slice(0, -1).every(row => row.status === 'completed'), 'interruption')
    } else check(report.result.status === 'completed' && report.history.every(row => row.status === 'completed'), 'completion')
    if (index > 0) {
      for (const previous of reports[index - 1].history) {
        const current = report.history.find(row => row.id === previous.id)
        check(current && (previous.status === 'completed' ? hash(current) === hash(previous)
          : current.startedAt === previous.startedAt && current.checksum === previous.checksum), 'history_rewritten')
      }
    }
  }
  check(hash(reports[2].history) === hash(reports[3].history), 'replay_history')
  return { registryHash, stepsCompleted: plan.steps.length, baselineHash: hash(baseline),
    referenceHash: hash(reference), reportHashes: reports.map(hash), executionTools: reference.tools }
}

export function prepareRiskRestorationEvidence(plan, input) {
  const { baseline, reference, reports, receiptBytes, publicReceipt, source, restored, priorProof } = input
  const chain = verifyRiskRehearsalChain(plan, baseline, reference, reports)
  const receipt = JSON.parse(receiptBytes.toString('utf8'))
  const receiptHash = sha256(receiptBytes)
  check(receiptHash === publicReceipt.privateReceiptSha256 && receiptHash === baseline.backupReceiptHash
    && receipt.status === 'verified' && receipt.sourceUnchanged === true
    && receipt.target === baseline.restoredIdentity.database && receipt.serverUuid === baseline.sourceIdentity.serverUuid
    && publicReceipt.status === 'verified' && publicReceipt.currentDevVueWrites === 0, 'backup')
  check(hash(source) === receipt.tablesSha256 && hash(priorProof) === baseline.priorProofHash
    && hash(priorProof.identity) === hash(baseline.sourceIdentity), 'source')
  const parity = verifyRiskRestoredSnapshot(source, restored)
  check(hash(legacyCandlePromotionSnapshot(source)) === baseline.sourceSnapshotHash
    && hash(legacyCandlePromotionSnapshot(restored)) === baseline.restoredSnapshotHash, 'snapshots')
  for (const [index, report] of reports.entries()) {
    check(report.tableCount === source.length + [1, 2, 7, 7][index], 'table_count')
  }
  return { kind: 'risk-restoration-evidence/v1', passed: true, ...chain,
    sourceIdentity: baseline.sourceIdentity, restoredIdentity: baseline.restoredIdentity,
    sourceSnapshotHash: baseline.sourceSnapshotHash, restoredSnapshotHash: baseline.restoredSnapshotHash,
    backupReceiptHash: receiptHash, priorProofHash: hash(priorProof), parity, sourceWrites: 0,
    snapshotEvidenceHash: hash({ source, restored }),
    scope: 'Historical backup and rehearsal chain verified. Current tools and current database upgrade are not certified.' }
}
