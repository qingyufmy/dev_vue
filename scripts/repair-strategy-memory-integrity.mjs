import crypto from 'node:crypto'
import '../server/config.js'
import { beijingNow, getDB, queryAll, queryOne, withTransaction } from '../server/db.js'

const TARGET = Object.freeze({
  caseId:1201,
  approvedVersionId:39,
  strategyId:1,
  pendingUpdateId:1,
  compressionJobId:2,
  incorrectRevisionId:3,
  currentVersionNo:3,
  expectedPendingHash:'74ffa31691075d97781de930182b67d43cedf86c18a23efe19809c42b9e7b298',
  expectedLibraryHash:'045626252e9234c061dfcf9d43cb8af72e216e1765d643c88f8616df7131cc42',
  executeConfirmation:'REPAIR_CASE_1201_STRATEGY_MEMORY',
})

function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex')
}

function charCount(value) {
  return Array.from(String(value ?? '')).length
}

function estimatedTokens(value) {
  return Math.ceil(Buffer.byteLength(String(value ?? ''), 'utf8') / 4)
}

function parseArgs(argv) {
  const execute = argv.includes('--execute')
  const confirmationIndex = argv.indexOf('--confirm')
  const confirmation = confirmationIndex >= 0 ? String(argv[confirmationIndex + 1] || '') : ''
  if (execute && confirmation !== TARGET.executeConfirmation) {
    throw new Error(`execution_confirmation_required: --confirm ${TARGET.executeConfirmation}`)
  }
  return { execute }
}

function rowsOf(raw) {
  return Array.isArray(raw?.[0]) ? raw[0] : []
}

function resultOf(raw) {
  return Array.isArray(raw) ? (raw[0] || {}) : (raw || {})
}

function removeLegacyApplicabilityLines(content) {
  const lines = String(content ?? '').replace(/\r\n?/g, '\n').split('\n')
  const kept = []
  let removed = 0
  for (const line of lines) {
    const text = line.trim()
    const label = text.replace(/^[-*+]\s+/u, '')
    if (/^(?:适用条件|规避条件)\s*[：:]/u.test(label)
        || /^(?:迁移来源|来源记录|来源ID|来源 ID)\s*[：:]/u.test(label)
        || /"(?:applicable_when|avoid_when)"\s*:/u.test(text)) {
      removed += 1
      continue
    }
    kept.push(line)
  }
  return { content:kept.join('\n').replace(/\n{3,}/g, '\n\n').trim(), removed }
}

function deterministicMonthlySection(pendingText) {
  const normalized = String(pendingText ?? '').replace(/\r\n?/g, '\n').trim()
  if (!normalized) throw new Error('pending_update_content_empty')
  if (/^##\s+/u.test(normalized)) return normalized
  return `## 2026-07 月复盘确认经验\n\n${normalized}`
}

async function readTarget() {
  const [review, pending, job, library, revision2, revision3, strategy] = await Promise.all([
    queryOne(`SELECT id, status, approved_version_id, strategy_id, strategy_scope, user_id
      FROM period_review_cases WHERE id = ?`, [TARGET.caseId]),
    queryOne(`SELECT * FROM strategy_memory_pending_updates WHERE id = ?`, [TARGET.pendingUpdateId]),
    queryOne(`SELECT * FROM strategy_memory_compression_jobs WHERE id = ?`, [TARGET.compressionJobId]),
    queryOne(`SELECT * FROM strategy_memory_libraries WHERE strategy_id = ?`, [TARGET.strategyId]),
    queryOne(`SELECT * FROM strategy_memory_library_revisions WHERE strategy_id = ? AND version_no = 2`, [TARGET.strategyId]),
    queryOne(`SELECT * FROM strategy_memory_library_revisions WHERE id = ?`, [TARGET.incorrectRevisionId]),
    queryOne(`SELECT id, scope, owner_user_id, version, deleted_at, is_active, visibility_status
      FROM auto_prompt_types WHERE id = ?`, [TARGET.strategyId]),
  ])
  return { review, pending, job, library, revision2, revision3, strategy }
}

function buildPlan(rows) {
  const failures = []
  const check = (condition, code) => { if (!condition) failures.push(code) }
  const { review, pending, job, library, revision2, revision3, strategy } = rows
  check(review?.status === 'approved' && Number(review?.approved_version_id) === TARGET.approvedVersionId,
    'review_approval_changed')
  check(Number(review?.strategy_id) === TARGET.strategyId && review?.strategy_scope === 'platform',
    'review_strategy_changed')
  check(Number(pending?.strategy_id) === TARGET.strategyId
      && Number(pending?.source_period_case_id) === TARGET.caseId
      && Number(pending?.source_period_review_version_id) === TARGET.approvedVersionId
      && pending?.update_kind === 'monthly_review', 'pending_source_changed')
  check(pending?.content_hash === TARGET.expectedPendingHash
      && sha256(pending?.content_text || '') === TARGET.expectedPendingHash, 'pending_hash_changed')
  check(pending?.status === 'merged' && Number(pending?.merged_revision_id) === TARGET.incorrectRevisionId,
    'pending_link_changed')
  check(Number(job?.strategy_id) === TARGET.strategyId
      && job?.trigger_type === 'monthly_review'
      && job?.status === 'succeeded'
      && Number(job?.result_revision_id) === TARGET.incorrectRevisionId, 'compression_job_changed')
  check(Number(library?.version_no) === TARGET.currentVersionNo
      && library?.content_hash === TARGET.expectedLibraryHash, 'library_version_changed')
  check(Number(revision2?.version_no) === 2 && revision2?.content_hash === TARGET.expectedLibraryHash,
    'revision_2_changed')
  check(Number(revision3?.id) === TARGET.incorrectRevisionId
      && Number(revision3?.version_no) === TARGET.currentVersionNo
      && revision3?.content_hash === TARGET.expectedLibraryHash, 'revision_3_changed')
  check(strategy?.scope === 'platform' && Number(strategy?.owner_user_id || 0) === 0
      && strategy?.deleted_at == null && Number(strategy?.is_active) === 1
      && strategy?.visibility_status === 'active', 'strategy_ownership_changed')

  const cleaned = removeLegacyApplicabilityLines(library?.content_text || '')
  const monthlySection = deterministicMonthlySection(pending?.content_text || '')
  check(!String(library?.content_text || '').includes(monthlySection), 'pending_content_already_present')
  const newContent = `${cleaned.content}\n\n${monthlySection}`.trim()
  const newHash = sha256(newContent)
  check(charCount(newContent) <= Number(library?.capacity_chars || 0), 'corrected_content_exceeds_capacity')
  check(newHash !== library?.content_hash, 'corrected_content_unchanged')
  return { failures, cleaned, monthlySection, newContent, newHash,
    nextVersionNo:Number(library?.version_no || 0) + 1 }
}

function report(rows, plan, mode) {
  return {
    ok:plan.failures.length === 0,
    mode,
    target:{ case_id:TARGET.caseId, approved_version_id:TARGET.approvedVersionId,
      strategy_id:TARGET.strategyId, pending_update_id:TARGET.pendingUpdateId,
      compression_job_id:TARGET.compressionJobId, incorrect_revision_id:TARGET.incorrectRevisionId },
    assertions:plan.failures.length ? plan.failures : ['all_passed'],
    before:{ library_version:Number(rows.library?.version_no || 0), library_hash:rows.library?.content_hash || null,
      library_chars:charCount(rows.library?.content_text || ''), pending_hash:rows.pending?.content_hash || null,
      pending_chars:charCount(rows.pending?.content_text || ''), pending_merged_revision_id:Number(rows.pending?.merged_revision_id || 0),
      compression_status:rows.job?.status || null, compression_result_revision_id:Number(rows.job?.result_revision_id || 0) },
    planned:{ library_version:plan.nextVersionNo, library_hash:plan.newHash,
      library_chars:charCount(plan.newContent), removed_legacy_metadata_lines:plan.cleaned.removed,
      update_lines:String(rows.pending?.content_text || '').split(/\r?\n/).filter(Boolean).length },
  }
}

async function executeRepair(expected, plan) {
  const now = beijingNow()
  return withTransaction(async run => {
    const lockedLibrary = rowsOf(await run(
      'SELECT * FROM strategy_memory_libraries WHERE strategy_id = ? FOR UPDATE', [TARGET.strategyId]))[0]
    const lockedPending = rowsOf(await run(
      'SELECT * FROM strategy_memory_pending_updates WHERE id = ? FOR UPDATE', [TARGET.pendingUpdateId]))[0]
    const lockedJob = rowsOf(await run(
      'SELECT * FROM strategy_memory_compression_jobs WHERE id = ? FOR UPDATE', [TARGET.compressionJobId]))[0]
    if (lockedLibrary?.content_hash !== expected.library.content_hash
        || Number(lockedLibrary?.version_no) !== Number(expected.library.version_no)
        || lockedPending?.content_hash !== expected.pending.content_hash
        || Number(lockedPending?.merged_revision_id) !== TARGET.incorrectRevisionId
        || Number(lockedJob?.result_revision_id) !== TARGET.incorrectRevisionId) {
      throw new Error('repair_target_changed_after_dry_run')
    }
    const insert = resultOf(await run(`INSERT INTO strategy_memory_library_revisions
      (strategy_id, version_no, change_reason, source_type, source_id, content_text, content_hash,
       char_count, estimated_token_count, actor_user_id, source_metadata_json, created_at)
      VALUES (?, ?, 'corrective_memory_merge', 'period_review_version', ?, ?, ?, ?, ?, ?, ?, ?)`,
    [TARGET.strategyId, plan.nextVersionNo, TARGET.approvedVersionId, plan.newContent, plan.newHash,
      charCount(plan.newContent), estimatedTokens(plan.newContent), expected.review.user_id || null,
      JSON.stringify({ corrective_repair:true, period_review_case_id:TARGET.caseId,
        source_period_review_version_id:TARGET.approvedVersionId,
        pending_update_ids:[TARGET.pendingUpdateId], incorrect_revision_id:TARGET.incorrectRevisionId,
        incorrect_compression_job_id:TARGET.compressionJobId }), now]))
    const revisionId = Number(insert.insertId || 0)
    if (!revisionId) throw new Error('corrective_revision_create_failed')
    const libraryUpdate = resultOf(await run(`UPDATE strategy_memory_libraries
      SET content_text = ?, version_no = ?, content_hash = ?, char_count = ?, estimated_token_count = ?,
          pending_update_count = 0, compression_status = 'queued', updated_by_user_id = ?, updated_at = ?
      WHERE strategy_id = ? AND version_no = ? AND content_hash = ?`,
    [plan.newContent, plan.nextVersionNo, plan.newHash, charCount(plan.newContent), estimatedTokens(plan.newContent),
      expected.review.user_id || null, now, TARGET.strategyId, TARGET.currentVersionNo, TARGET.expectedLibraryHash]))
    if (Number(libraryUpdate.affectedRows || 0) !== 1) throw new Error('corrective_library_cas_failed')
    const pendingUpdate = resultOf(await run(`UPDATE strategy_memory_pending_updates
      SET merged_revision_id = ?, updated_at = ?, completed_at = COALESCE(completed_at, ?)
      WHERE id = ? AND status = 'merged' AND merged_revision_id = ?`,
    [revisionId, now, now, TARGET.pendingUpdateId, TARGET.incorrectRevisionId]))
    if (Number(pendingUpdate.affectedRows || 0) !== 1) throw new Error('corrective_pending_cas_failed')
    await run(`UPDATE strategy_memory_compression_jobs
      SET result_validation_status = 'corrected', result_validation_json = ?, updated_at = ?
      WHERE id = ? AND result_revision_id = ?`,
    [JSON.stringify({ memory_preserved:false, corrected_by_revision_id:revisionId,
      reason:'provider_result_omitted_approved_pending_update' }), now,
    TARGET.compressionJobId, TARGET.incorrectRevisionId])
    const sourceSetHash = sha256(JSON.stringify({ strategyId:TARGET.strategyId,
      sourceVersionNo:plan.nextVersionNo, trigger:'monthly_review', updateIds:[] }))
    const targetChars = Math.floor(Number(lockedLibrary.capacity_chars)
      * Number(lockedLibrary.compression_target_ratio))
    const compressionInsert = resultOf(await run(`INSERT INTO strategy_memory_compression_jobs
      (strategy_id, trigger_type, source_version_no, source_content_hash, source_set_hash,
       pending_update_ids_json, target_chars, status, attempt_count, max_attempts, lease_token,
       lease_expires_at, next_attempt_at, model_task_id, last_error_code, result_revision_id,
       result_content_hash, result_validation_status, result_validation_json, created_at, updated_at, completed_at)
      VALUES (?, 'monthly_review', ?, ?, ?, '[]', ?, 'queued', 0, 3, NULL,
       NULL, NULL, NULL, NULL, NULL, NULL, 'pending', NULL, ?, ?, NULL)`,
    [TARGET.strategyId, plan.nextVersionNo, plan.newHash, sourceSetHash, targetChars, now, now]))
    const compressionJobId = Number(compressionInsert.insertId || 0)
    if (!compressionJobId) throw new Error('corrective_compression_job_create_failed')
    await run(`INSERT INTO audit_logs
      (user_id, user_email, user_nickname, action, target_type, target_id, detail, ip, user_agent)
      VALUES (?, '', '', 'strategy_memory_integrity_corrected', 'ai_strategy', ?, ?, '', 'repair-strategy-memory-integrity.mjs')`,
    [expected.review.user_id || null, TARGET.strategyId, JSON.stringify({ case_id:TARGET.caseId,
      approved_version_id:TARGET.approvedVersionId, pending_update_id:TARGET.pendingUpdateId,
      old_revision_id:TARGET.incorrectRevisionId, corrective_revision_id:revisionId,
      old_hash:TARGET.expectedLibraryHash, new_hash:plan.newHash })])
    return { revisionId, compressionJobId }
  })
}

async function scanPotentialIntegrityFailures() {
  return queryAll(`SELECT pending.id AS pending_update_id, pending.strategy_id,
      pending.source_period_case_id, pending.source_period_review_version_id,
      pending.merged_revision_id, revisions.version_no AS merged_version_no,
      revisions.content_hash AS merged_hash, parent.content_hash AS parent_hash
    FROM strategy_memory_pending_updates pending
    JOIN strategy_memory_library_revisions revisions ON revisions.id = pending.merged_revision_id
    LEFT JOIN strategy_memory_library_revisions parent
      ON parent.strategy_id = revisions.strategy_id AND parent.version_no = revisions.version_no - 1
    WHERE pending.status = 'merged'
      AND (revisions.strategy_id <> pending.strategy_id
        OR revisions.content_hash = COALESCE(parent.content_hash, revisions.content_hash))
    ORDER BY pending.id ASC LIMIT 200`)
}

let exitCode = 0
try {
  const args = parseArgs(process.argv.slice(2))
  const rows = await readTarget()
  const plan = buildPlan(rows)
  const potential = await scanPotentialIntegrityFailures()
  const output = report(rows, plan, args.execute ? 'execute' : 'dry-run')
  output.scan = { potential_count:potential.length,
    objects:potential.map(row => ({ pending_update_id:Number(row.pending_update_id), strategy_id:Number(row.strategy_id),
      period_review_case_id:Number(row.source_period_case_id || 0), merged_revision_id:Number(row.merged_revision_id || 0),
      merged_version_no:Number(row.merged_version_no || 0), same_as_parent:row.merged_hash === row.parent_hash })) }
  if (plan.failures.length) {
    exitCode = 2
  } else if (args.execute) {
    const executed = await executeRepair(rows, plan)
    output.corrective_revision_id = executed.revisionId
    output.corrective_compression_job_id = executed.compressionJobId
    output.executed = true
  } else {
    output.executed = false
    output.execution_command = `node scripts/repair-strategy-memory-integrity.mjs --execute --confirm ${TARGET.executeConfirmation}`
  }
  console.log(JSON.stringify(output, null, 2))
} catch (error) {
  exitCode = 1
  console.error(JSON.stringify({ ok:false, error:String(error?.message || error) }, null, 2))
} finally {
  await getDB().end().catch(() => {})
  process.exitCode = exitCode
}
