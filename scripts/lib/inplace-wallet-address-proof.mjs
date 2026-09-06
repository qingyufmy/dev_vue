import { readFile } from 'node:fs/promises'
import { sha256 } from './v4-migration-plan.mjs'

export async function verifyWalletAddressProof(root) {
  const bytes = await readFile(new URL('docs/migration/dev-vue-wallet-address-rehearsal-20260907.json', root))
  if (sha256(bytes) !== '60c9352b3fccee5ce892b9206424c21e89adfaa3df372a46a5a59f31b8bbb85f') throw Error('inplace_wallet_proof_changed')
  const proof = JSON.parse(bytes)
  if (proof.kind !== 'wallet-address-upgrade/v1' || !proof.apply || proof.schemaSteps !== 54 || proof.ddlCount !== 1
    || !proof.faultObserved || !proof.repeated || !proof.originalRowsVerified || !proof.protectedRowsVerified
    || proof.identity.db !== 'dev_vue_m1_source_20260907_02' || proof.currentDevVueWritten !== false
    || proof.result.steps.at(-1).status !== 'reconciled') throw Error('inplace_wallet_proof_invalid')
  for (const file of proof.toolManifest) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(file.path) || file.path.split('/').includes('..')
      || sha256(await readFile(new URL(file.path, root))) !== file.sha256) throw Error('inplace_wallet_proof_tools_changed')
  }
  return { sha256: sha256(bytes), files: proof.toolManifest.length, faultRecovered: true }
}

export async function readWalletAddressRows(connection) {
  const [[table]] = await connection.execute('SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', ['payment_wallet_addresses'])
  if (!Number(table.n)) return null
  const [rows] = await connection.query('SELECT id,chain,address_index,address,created_at_utc,custody_reference,custody_evidence_sha256,custody_verified_at_utc,revision,origin,migration_run_id,source_sha256,imported_at_utc FROM payment_wallet_addresses ORDER BY id')
  return { rows: rows.length, hash: sha256(JSON.stringify(rows)) }
}
