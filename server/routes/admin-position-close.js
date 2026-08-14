import crypto from 'node:crypto'
import { Router } from 'express'
import { authMiddleware, adminOnly } from '../middleware/auth.js'
import { beijingNow, logAudit, queryAll, queryOne, queryRun, withTransaction } from '../db.js'
import {
  resolveAdminSystemPositionTargets,
  ADMIN_SYSTEM_POSITION_MAGIC,
  ADMIN_SYSTEM_POSITION_SOURCE,
} from '../services/admin-system-position-targets.js'

const router = Router()
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'skipped'])

function text(value) { return String(value ?? '').trim() }

function fail(code, details = {}) {
  const error = new Error(code)
  error.code = code
  error.details = details
  return error
}

function parseJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value
  try { return value ? JSON.parse(value) : fallback } catch { return fallback }
}

function normalizeCloseInput(body = {}, headers = {}) {
  const reason = text(body.reason)
  if (reason.length < 2 || reason.length > 500) throw fail('close_reason_required')
  const key = text(body.idempotency_key || body.client_request_id || headers['idempotency-key']) || crypto.randomUUID()
  if (key.length > 191) throw fail('idempotency_key_invalid')
  return { reason, idempotency_key:key }
}

function snapshot(value) {
  return JSON.stringify(value && typeof value === 'object' ? value : {})
}

function serializeTarget(row) {
  return {
    id:Number(row.id), target_order:Number(row.target_order || 0),
    target_role:text(row.target_role), is_source:Boolean(Number(row.is_source)),
    user_id:Number(row.user_id), trading_account_id:Number(row.trading_account_id),
    ownership_history_id:row.ownership_history_id == null ? null : Number(row.ownership_history_id),
    outcome_id:row.outcome_id == null ? null : Number(row.outcome_id), signal_id:Number(row.signal_id),
    broker_server_key:text(row.broker_server_key), login_account:text(row.login_account),
    ticket:text(row.ticket), symbol:text(row.symbol), direction:text(row.direction),
    volume:Number(row.volume || 0), magic:Number(row.magic || ADMIN_SYSTEM_POSITION_MAGIC),
    bridge_generation:row.bridge_generation == null ? null : Number(row.bridge_generation),
    operation_id:text(row.operation_id), status:text(row.status), attempt_count:Number(row.attempt_count || 0),
    exclusion_reason:row.exclusion_reason || null, error_code:row.error_code || null,
    error_message:row.error_message || null,
    last_result:parseJson(row.last_result_json, null),
    send_started_at:row.send_started_at || null, send_finished_at:row.send_finished_at || null,
    reconcile_started_at:row.reconcile_started_at || null, completed_at:row.completed_at || null,
  }
}

export async function getAdminPositionCloseJob(jobId, actorUserId = null, { includeTargets = true } = {}) {
  const job = await queryOne('SELECT * FROM admin_position_close_jobs WHERE id = ? LIMIT 1', [Number(jobId)])
  if (!job || (actorUserId != null && Number(job.actor_user_id) !== Number(actorUserId))) return null
  const targets = includeTargets
    ? await queryAll(`SELECT * FROM admin_position_close_targets WHERE job_id = ?
      ORDER BY CASE WHEN target_role = 'subscriber' THEN 0 ELSE 1 END, target_order, id`, [Number(jobId)])
    : []
  const total = Number(job.target_count || 0)
  const completed = Number(job.succeeded_target_count || 0) + Number(job.failed_target_count || 0)
    + Number(job.skipped_target_count || 0)
  return {
    id:Number(job.id), idempotency_key:text(job.idempotency_key), status:text(job.status),
    actor_user_id:Number(job.actor_user_id), source_signal_id:Number(job.source_signal_id),
    source_ticket:text(job.source_ticket), source_user_id:Number(job.source_user_id),
    source_trading_account_id:Number(job.source_trading_account_id), source_symbol:text(job.source_symbol),
    source_direction:text(job.source_direction), source_volume:Number(job.source_volume || 0),
    source_magic:Number(job.source_magic || ADMIN_SYSTEM_POSITION_MAGIC), reason:text(job.reason),
    preview_hash:text(job.preview_hash), target_count:total,
    eligible_target_count:Number(job.eligible_target_count || 0),
    succeeded:Number(job.succeeded_target_count || 0), failed:Number(job.failed_target_count || 0),
    skipped:Number(job.skipped_target_count || 0), uncertain:Number(job.uncertain_target_count || 0),
    succeeded_target_count:Number(job.succeeded_target_count || 0),
    failed_target_count:Number(job.failed_target_count || 0),
    skipped_target_count:Number(job.skipped_target_count || 0),
    uncertain_target_count:Number(job.uncertain_target_count || 0),
    progress_percent:total ? Math.round(completed / total * 100) : 0,
    created_at:job.created_at, started_at:job.started_at, completed_at:job.completed_at,
    ...(includeTargets ? { targets:targets.map(serializeTarget) } : {}),
  }
}

function jobError(code, details = {}) { return fail(code, details) }

async function insertCloseJob(actorUserId, input, preview) {
  const now = beijingNow()
  const source = preview.source
  const frozenTargets = [...preview.targets]
  const excludedTargets = (preview.exclusions || []).filter(item => item && !item.is_source)
  const seen = new Set(frozenTargets.map(target => `${target.user_id}:${target.trading_account_id}:${target.ticket}`))
  for (const item of excludedTargets) {
    const key = `${item.user_id || 0}:${item.trading_account_id || 0}:${item.ticket || ''}`
    if (seen.has(key)) continue
    seen.add(key)
    frozenTargets.push({ ...item, target_role:'subscriber', is_source:false, eligible:false,
      exclusion_reason:item.reason || item.exclusion_reason || 'excluded',
      signal_id:Number(item.signal_id || preview.source_signal_id), magic:ADMIN_SYSTEM_POSITION_MAGIC,
      volume:Number(item.volume || 0), symbol:text(item.symbol), direction:text(item.direction), ticket:text(item.ticket),
    })
  }
  frozenTargets.sort((a, b) => Number(a.is_source) - Number(b.is_source)
    || Number(a.target_order || 0) - Number(b.target_order || 0))
  return withTransaction(async run => {
    const [existingRows] = await run('SELECT id, actor_user_id FROM admin_position_close_jobs WHERE idempotency_key = ? LIMIT 1', [input.idempotency_key])
    if (existingRows?.[0]) {
      if (Number(existingRows[0].actor_user_id) !== Number(actorUserId)) throw jobError('idempotency_key_conflict')
      return Number(existingRows[0].id)
    }
    const [jobResult] = await run(`INSERT INTO admin_position_close_jobs
      (idempotency_key, actor_user_id, source_signal_id, source_ticket, source_user_id,
       source_trading_account_id, source_symbol, source_direction, source_volume, source_magic,
       reason, preview_hash, status, target_count, eligible_target_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`, [
      input.idempotency_key, Number(actorUserId), Number(preview.source_signal_id), text(preview.source_ticket),
      Number(source.user_id), Number(source.trading_account_id), text(source.symbol), text(source.direction),
      Number(source.volume || 0), ADMIN_SYSTEM_POSITION_MAGIC, input.reason, preview.preview_hash,
      frozenTargets.length, frozenTargets.filter(target => target.eligible !== false).length, now, now,
    ])
    const jobId = Number(jobResult.insertId)
    let order = 0
    for (const target of frozenTargets) {
      const role = target.is_source ? 'source' : 'subscriber'
      const targetId = await (async () => {
        const [result] = await run(`INSERT INTO admin_position_close_targets
          (job_id, target_order, target_role, is_source, user_id, trading_account_id,
           ownership_history_id, outcome_id, signal_id, broker_server_key, login_account,
           ticket, symbol, direction, volume, magic, user_snapshot_json, account_snapshot_json,
           ownership_snapshot_json, outcome_snapshot_json, target_snapshot_json, bridge_generation,
           operation_id, status, error_code, error_message, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
          jobId, order++, role, target.is_source ? 1 : 0, Number(target.user_id || 0), Number(target.trading_account_id || 0),
          target.ownership_history_id || null, target.outcome_id || null, Number(target.signal_id || preview.source_signal_id),
          text(target.broker_server_key), text(target.login_account), text(target.ticket), text(target.symbol), text(target.direction),
          Number(target.volume || 0), ADMIN_SYSTEM_POSITION_MAGIC, snapshot(target.user_snapshot), snapshot(target.account_snapshot),
          snapshot(target.ownership_snapshot), snapshot(target.outcome_snapshot), snapshot(target.target_snapshot || target),
          target.bridge_generation == null ? null : Number(target.bridge_generation),
          `pending:${input.idempotency_key}:${order}`, target.eligible === false ? 'skipped' : 'pending',
          target.eligible === false ? text(target.exclusion_reason || target.reason || 'excluded') : null,
          target.eligible === false ? text(target.exclusion_reason || target.reason || 'excluded') : null,
          now, now,
        ])
        return Number(result.insertId)
      })()
      await run('UPDATE admin_position_close_targets SET operation_id = ? WHERE id = ?', [`admin-position-close:${jobId}:${targetId}`, targetId])
    }
    return jobId
  })
}

export async function createAdminPositionCloseJob(actorUserId, body = {}, headers = {}) {
  const input = normalizeCloseInput(body, headers)
  const sourceTicket = text(body.source_ticket || body.ticket)
  if (!sourceTicket) throw jobError('position_ticket_required')
  const existing = await queryOne('SELECT id, actor_user_id FROM admin_position_close_jobs WHERE idempotency_key = ? LIMIT 1', [input.idempotency_key])
  if (existing) {
    if (Number(existing.actor_user_id) !== Number(actorUserId)) throw jobError('idempotency_key_conflict')
    return getAdminPositionCloseJob(existing.id)
  }
  const preview = await resolveAdminSystemPositionTargets(Number(actorUserId), sourceTicket, { includeSubscribers:true })
  if (text(body.preview_hash) !== text(preview.preview_hash)) throw jobError('preview_hash_mismatch', { preview_hash:preview.preview_hash })
  const jobId = await insertCloseJob(Number(actorUserId), input, preview)
  return getAdminPositionCloseJob(jobId)
}

export async function retryFailedAdminPositionCloseJob(actorUserId, jobId, body = {}) {
  const job = await getAdminPositionCloseJob(jobId, actorUserId)
  if (!job) throw jobError('position_close_job_not_found')
  if (['queued', 'running', 'reconciling'].includes(job.status)) throw jobError('position_close_job_active')
  if (job.uncertain > 0 || job.uncertain_target_count > 0) throw jobError('uncertain_requires_reconciliation')
  const preview = await resolveAdminSystemPositionTargets(actorUserId, job.source_ticket, { includeSubscribers:true })
  if (text(body.preview_hash) !== text(preview.preview_hash)) throw jobError('preview_hash_mismatch', { preview_hash:preview.preview_hash })
  const failed = await queryAll(`SELECT id FROM admin_position_close_targets
    WHERE job_id = ? AND status = 'failed' ORDER BY target_order, id`, [Number(jobId)])
  if (!failed.length) throw jobError('no_failed_targets')
  const now = beijingNow()
  await withTransaction(async run => {
    await run(`UPDATE admin_position_close_targets SET status = 'pending', error_code = NULL,
      error_message = NULL, last_result_json = NULL, send_started_at = NULL,
      send_finished_at = NULL, reconcile_started_at = NULL, completed_at = NULL,
      lease_token = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE job_id = ? AND status = 'failed'`, [now, Number(jobId)])
    await run(`UPDATE admin_position_close_jobs SET status = 'queued', completed_at = NULL,
      preview_hash = ?, updated_at = ? WHERE id = ?`, [preview.preview_hash, now, Number(jobId)])
  })
  return getAdminPositionCloseJob(jobId, actorUserId)
}

function statusForError(error) {
  const code = text(error?.code || error?.message)
  if (['position_close_job_not_found', 'admin_dispatch_attribution_unavailable', 'admin_dispatch_attribution_ambiguous', 'system_position_not_found'].includes(code)) return 404
  if (['position_close_job_active', 'preview_hash_mismatch', 'uncertain_requires_reconciliation', 'no_failed_targets', 'idempotency_key_conflict'].includes(code)) return 409
  if (code.includes('forbidden') || code === 'admin_required') return 403
  return 400
}

function sendError(res, error) {
  return res.status(statusForError(error)).json({ ok:false, error:text(error?.code || error?.message || 'admin_position_close_failed'), details:error?.details || {} })
}

router.get('/admin/ai/positions/:ticket/close-preview', authMiddleware, adminOnly, async (req, res) => {
  try {
    const preview = await resolveAdminSystemPositionTargets(req.user.id, req.params.ticket, { includeSubscribers:true })
    res.json({ ok:true, preview, ...preview })
  } catch (error) { sendError(res, error) }
})

router.post('/admin/ai/position-close-jobs', authMiddleware, adminOnly, async (req, res) => {
  try {
    const job = await createAdminPositionCloseJob(req.user.id, req.body || {}, req.headers || {})
    await logAudit({ userId:req.user.id, action:'admin_position_close_job_created', targetType:'admin_position_close_job', targetId:job.id,
      detail:JSON.stringify({ source_ticket:job.source_ticket, source_signal_id:job.source_signal_id, reason:job.reason }), ip:req.ip, userAgent:req.headers['user-agent'] })
    res.status(202).json({ ok:true, job, position_close_job:job })
  } catch (error) { sendError(res, error) }
})

router.get('/admin/ai/position-close-jobs/:jobId', authMiddleware, adminOnly, async (req, res) => {
  try {
    const job = await getAdminPositionCloseJob(req.params.jobId, req.user.id)
    if (!job) return res.status(404).json({ ok:false, error:'position_close_job_not_found' })
    res.json({ ok:true, job, position_close_job:job })
  } catch (error) { sendError(res, error) }
})

router.post('/admin/ai/position-close-jobs/:jobId/retry-failed', authMiddleware, adminOnly, async (req, res) => {
  try {
    const job = await retryFailedAdminPositionCloseJob(req.user.id, req.params.jobId, req.body || {})
    await logAudit({ userId:req.user.id, action:'admin_position_close_job_retry_failed', targetType:'admin_position_close_job', targetId:job.id,
      detail:JSON.stringify({ preview_hash:text(req.body?.preview_hash) }), ip:req.ip, userAgent:req.headers['user-agent'] })
    res.status(202).json({ ok:true, job, position_close_job:job })
  } catch (error) { sendError(res, error) }
})

export { normalizeCloseInput, serializeTarget, insertCloseJob }
export default router
