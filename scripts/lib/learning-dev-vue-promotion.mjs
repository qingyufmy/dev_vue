import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { requireBackfill as check } from './v4-backfill-contract.mjs'

const digest = value => createHash('sha256').update(value).digest('hex')
export function validateLearningPromotion(promotion, receipt, manifests, serverUuid) {
  check(promotion?.kind === 'learning-dev-vue-promotion/v1' && promotion.timePolicy === 'legacy-wall-clock-as-utc'
    && promotion.userAcceptedHistoricalOffsetLoss === true, 'learning_promotion_policy')
  check(receipt?.kind === 'learning-backfill-rehearsal/v1' && receipt.executionHost === 'local'
    && ['commitUnknownObserved', 'partialRecoveryDidNotWrite', 'fullRecoveryVerified', 'repeatNoop', 'fixtureCleanupVerified', 'cliEndToEndVerified'].every(key => receipt[key] === true)
    && receipt.cli?.allTableRowsRestored === true, 'learning_promotion_rehearsal')
  for (const [kind, manifest] of Object.entries(manifests)) {
    const binding = manifest.spec.bindings
    check(binding.targetDatabase === 'dev_vue' && binding.targetServerUuid === serverUuid
      && receipt.identities[kind]?.serverUuid === serverUuid
      && receipt.identities[kind]?.schemaHash === binding.schemaHash
      && promotion.manifestHashes[kind] === binding.manifestHash, 'learning_promotion_binding')
    const audit = receipt[kind === 'courses' ? 'courseAudit' : 'progressAudit']
    check(audit?.importMatchesReviewedInputs === true && audit.differences.length === 0 && audit.control?.verified === true, 'learning_promotion_audit')
    for (const row of manifest.options.basis.resolutions) {
      for (const key of kind === 'courses' ? ['createdAt', 'updatedAt'] : ['updatedAt']) {
        const rule = row[key]
        check(rule.raw === null ? rule.offsetMinutes === null : rule.offsetMinutes === 0, 'learning_promotion_time_offset')
      }
    }
  }
}

export async function assertLearningPromotion(path, manifests, serverUuid) {
  check(typeof path === 'string' && isAbsolute(path), 'learning_entry_dev_vue_apply_requires_rehearsal')
  const promotion = JSON.parse(await readFile(path, 'utf8'))
  check(isAbsolute(promotion.rehearsalPath), 'learning_promotion_receipt_path')
  const bytes = await readFile(promotion.rehearsalPath)
  check(digest(bytes) === promotion.rehearsalSha256, 'learning_promotion_receipt_hash')
  const receipt = JSON.parse(bytes)
  validateLearningPromotion(promotion, receipt, manifests, serverUuid)
  // The promoted entry point changes; the rehearsed transforms, SQL writers,
  // audit readers, transaction runners and migration definitions must not drift.
  const selected = receipt.toolManifest.filter(item => item.path.startsWith('server/db/migrations/')
    || item.path.startsWith('scripts/lib/') && item.path !== 'scripts/lib/v4-learning-command.mjs')
  check(selected.length > 20, 'learning_promotion_tool_scope')
  for (const item of selected) {
    check(!item.path.includes('..') && digest(await readFile(new URL(`../../${item.path}`, import.meta.url))) === item.sha256, 'learning_promotion_tool_drift')
  }
}
