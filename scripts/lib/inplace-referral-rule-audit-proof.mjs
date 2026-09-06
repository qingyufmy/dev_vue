import { readFile } from 'node:fs/promises'
import { sha256 } from './v4-migration-plan.mjs'

export async function verifyReferralRuleAuditProof(root) {
  const bytes = await readFile(new URL('docs/migration/dev-vue-referral-rule-audit-rehearsal-20260907.json', root))
  if (sha256(bytes) !== '3ac2058754643ec305018a85886b85f1f7717f7244c78abe403b040bfb588f9c') throw Error('inplace_rule_proof_changed')
  const proof = JSON.parse(bytes)
  if (proof.kind !== 'referral-rule-audit-upgrade/v1' || !proof.apply || proof.schemaSteps !== 53 || proof.ddlCount !== 1
    || !proof.faultObserved || !proof.repeated || !proof.originalRowsVerified || !proof.protectedRowsVerified
    || proof.identity.db !== 'dev_vue_m1_source_20260907_02' || proof.currentDevVueWritten !== false
    || proof.result.steps.at(-1).status !== 'reconciled') throw Error('inplace_rule_proof_invalid')
  for (const file of proof.toolManifest) {
    if (!/^[a-zA-Z0-9_./-]+$/.test(file.path) || file.path.split('/').includes('..')
      || sha256(await readFile(new URL(file.path, root))) !== file.sha256) throw Error('inplace_rule_proof_tools_changed')
  }
  return { sha256: sha256(bytes), files: proof.toolManifest.length, faultRecovered: true }
}

export async function readReferralRuleAuditRows(connection) {
  const [[table]] = await connection.execute('SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', ['referral_rule_changes'])
  if (!Number(table.n)) return null
  const [rows] = await connection.query('SELECT rule_id,rule_revision,request_id,actor_user_id,previous_rate_bps,rate_bps,previous_enabled,enabled,recorded_at_utc FROM referral_rule_changes ORDER BY rule_id,rule_revision')
  return { rows: rows.length, hash: sha256(JSON.stringify(rows)) }
}
