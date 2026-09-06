import { readFile } from 'node:fs/promises'
import { sha256 } from './v4-migration-plan.mjs'

export async function verifyReferralRuleProof(root) {
  const bytes = await readFile(new URL('docs/migration/dev-vue-referral-rule-rehearsal-20260907.json', root))
  if (sha256(bytes) !== '5a75e18038faa6e7c55ddb213b15df702b2796d9be5046922f974662761b2fb8') throw Error('inplace_rule_proof_changed')
  const proof = JSON.parse(bytes)
  if (proof.kind !== 'referral-rule-upgrade/v1' || !proof.apply || proof.schemaSteps !== 52 || proof.ddlCount !== 1
    || !proof.faultObserved || !proof.repeated || !proof.originalRowsVerified || !proof.protectedRowsVerified
    || proof.identity.db !== 'dev_vue_m1_source_20260907_02' || proof.currentDevVueWritten !== false
    || proof.result.steps.at(-1).status !== 'reconciled') throw Error('inplace_rule_proof_invalid')
  for (const file of proof.toolManifest) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(file.path) || file.path.split('/').includes('..')
      || sha256(await readFile(new URL(file.path, root))) !== file.sha256) throw Error('inplace_rule_proof_tools_changed')
  }
  return { sha256: sha256(bytes), files: proof.toolManifest.length, faultRecovered: true }
}

export async function readReferralRuleRevisions(connection) {
  const [[column]] = await connection.execute('SELECT COUNT(*) n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?', ['referral_rules', 'revision'])
  if (!Number(column.n)) return null
  const [rows] = await connection.query('SELECT CAST(id AS CHAR) id,CAST(revision AS CHAR) revision FROM referral_rules ORDER BY referral_rules.id')
  return rows.map(row => ({ ...row }))
}
