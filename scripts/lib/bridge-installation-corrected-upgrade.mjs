import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { loadBridgeInstallationUpgrade } from './bridge-installation-upgrade.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'
import { hash } from './v4-backfill-contract.mjs'
import { sha256, splitSqlStatements } from './v4-migration-plan.mjs'

export const bridgeInstallationCorrectionId = 'inplace_080_01a_limits_collation_correction'
export const bridgeInstallationCorrectionFile = 'server/db/migrations/corrections/080-bridge-installation-request-limits-collation.sql'
const proofFile = 'docs/architecture/bridge-installation-collation-reference-v1-20260914.json'
const table = 'bridge_installation_request_limits'

// Derivation is shared with the reference runner. It does not claim that the
// correction has been executed; only the separately consumed proof does that.
export function deriveBridgeInstallationCorrection(base, rawSqlBytes) {
  assert.equal(base.steps.length, 271)
  assert.equal(base.added.length, 4)
  const original = base.added[0]
  assert.equal(original.id, 'inplace_080_01_bridge_installation')
  assert.equal(base.steps[267].checksum, original.checksum)
  const ddl = base.definitions[table]
  assert.equal(typeof ddl, 'string')
  assert.match(ddl, /\) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci$/)
  const expectedAfterTableHash = tableDefinitionHash(ddl)
  assert.equal(expectedAfterTableHash, base.finalTableHashes[table])
  // Change only the table default. In particular, ip_hash retains ascii_bin.
  const beforeDdl = ddl.replace(/COLLATE=utf8mb4_unicode_ci$/, 'COLLATE=utf8mb4_general_ci')
  const actualBeforeTableHash = tableDefinitionHash(beforeDdl)
  assert.notEqual(actualBeforeTableHash, expectedAfterTableHash)
  const statements = splitSqlStatements(rawSqlBytes.toString('utf8'))
  assert.equal(statements.length, 1)
  const sql = statements[0]
  assert.match(sql, /^ALTER TABLE bridge_installation_request_limits\s+DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci$/)
  const body = { id: bridgeInstallationCorrectionId, protocol: 'bridge-installation-limits-collation/v1',
    originalStepId: original.id, originalStepChecksum: original.checksum, sql,
    correctionFileSha256: sha256(rawSqlBytes), correctionSqlSha256: sha256(sql),
    actualBeforeTableHash, expectedAfterTableHash }
  return { ...body, checksum: hash(body) }
}

export function composeCorrectedBridgeInstallationUpgrade(base, rawSqlBytes, proof) {
  const correction = deriveBridgeInstallationCorrection(base, rawSqlBytes)
  for (const field of ['passed', 'referenceDatabaseRemoved', 'ddlAckLossRecovered', 'replayNoDDL']) {
    assert.equal(proof[field], true, `bridge_installation_correction_proof_${field}`)
  }
  for (const field of ['originalStepId', 'originalStepChecksum', 'correctionFileSha256', 'correctionSqlSha256',
    'actualBeforeTableHash', 'expectedAfterTableHash', 'sql']) {
    assert.equal(proof[field], correction[field], `bridge_installation_correction_proof_${field}`)
  }
  // This is an admission registry, NOT a linear coordinator plan. The dedicated
  // executor validates the correction row before filtering it and using base.
  // Preserve original transitions, prior, added steps and all 271 checksums.
  return { ...base, steps: [...base.steps, correction], correction }
}

export async function loadCorrectedBridgeInstallationUpgrade(root) {
  const [base, sql, rawProof] = await Promise.all([loadBridgeInstallationUpgrade(root),
    readFile(new URL(bridgeInstallationCorrectionFile, root)), readFile(new URL(proofFile, root), 'utf8')])
  return composeCorrectedBridgeInstallationUpgrade(base, sql, JSON.parse(rawProof))
}
