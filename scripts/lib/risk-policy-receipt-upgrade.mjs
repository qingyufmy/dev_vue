import { readFile } from 'node:fs/promises'
import { loadRiskStructureMigration } from './inplace-risk-structure.mjs'
import { splitSqlStatements, sha256 } from './v4-migration-plan.mjs'
import { hash } from './v4-backfill-contract.mjs'
import { inspectSingleTableUpgrade, coordinateSingleTableUpgrade } from './single-table-upgrade-coordinator.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'

const check = (value, code) => { if (!value) throw Error('risk_receipt_upgrade_' + code) }
export const riskReceiptPlanHash = plan => hash({ steps: plan.steps, step: plan.step, referenceHash: plan.referenceHash })
export const receiptReferenceChecks = Object.freeze(['concurrent-same-request-one-result', 'single-version-audit-outbox-receipt',
  'changed-body-conflicts', 'lost-commit-ack-recovered-without-new-writes', 'receipt-failure-rolls-back-policy-audit-outbox',
  'database-enforces-request-uniqueness', 'summary-and-manual-release-utc-roundtrip',
  'deteriorated-summary-invalidates-release-with-utc-time', 'receipt-read-rechecks-owner-and-scope', 'utc-milliseconds-preserved'])

export async function loadRiskPolicyReceiptUpgrade(root, reference) {
  const prior = await loadRiskStructureMigration(root)
  check(prior.steps.length === 174, 'prior_version')
  const source = 'server/db/migrations/inplace/044_risk_policy_write_receipts.sql'
  const bytes = await readFile(new URL(source, root)), statements = splitSqlStatements(bytes.toString('utf8'))
  check(statements.length === 1 && /^CREATE TABLE risk_policy_write_receipts\s*\(/.test(statements[0]), 'sql_scope')
  check(reference?.kind === 'risk-policy-receipt-reference/v1' && reference.passed === true
    && reference.migrationSha256 === sha256(bytes) && reference.referenceDatabaseRemoved === true
    && reference.existingDatabaseWrites === 0 && reference.serverUuid === 'ac423207-6ef3-11f1-b302-000c29fda104'
    && hash(reference.checks) === hash(receiptReferenceChecks)
    && reference.canonicalDdl?.startsWith('CREATE TABLE `risk_policy_write_receipts` ('), 'reference')
  const body = { id: 'inplace_044_01_risk_policy_write_receipts', table: 'risk_policy_write_receipts',
    protocol: 'risk-policy-receipt-structure/v1', sql: statements[0], source, sourceSha256: sha256(bytes),
    priorRegistryHash: hash(prior.steps.map(({ id, checksum }) => ({ id, checksum }))),
    afterHash: tableDefinitionHash(reference.canonicalDdl) }
  const step = { ...body, checksum: hash(body) }
  return { prior, step, steps: [...prior.steps, step], referenceHash: hash(reference) }
}

/** Store must validate live identity, held lock, proof, prior history and protected snapshot. */
export async function inspectRiskPolicyReceiptUpgrade(store, plan) {
  return inspectSingleTableUpgrade(store, plan, 'risk_receipt_upgrade')
}

export async function coordinateRiskPolicyReceiptUpgrade(store, plan, options) {
  return coordinateSingleTableUpgrade(store, plan, 'risk_receipt_upgrade', options)
}
