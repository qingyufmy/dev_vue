import { Router } from 'express'
import { authMiddleware, adminOnly } from '../middleware/auth.js'
import { logAudit } from '../db.js'
import {
  ADMIN_STRATEGY_TRADE_ENTRY_METHODS,
  buildAdminStrategyTradePreview,
  cancelAdminStrategyTradeDispatch,
  createAdminStrategyTradeDispatch,
  getAdminStrategyTradeDispatch,
  retryAdminStrategyTradeDispatch,
} from '../services/admin-strategy-trades.js'
import {
  buildAdminStrategyPendingCancelPreview,
  createAdminStrategyPendingCancelJob,
  getAdminStrategyPendingCancelJob,
  retryFailedAdminStrategyPendingCancelJob,
} from '../services/admin-strategy-pending-cancel.js'

const router = Router()

function statusForError(error) {
  if (['dispatch_not_found', 'platform_strategy_not_found', 'source_account_not_found', 'pending_cancel_job_not_found'].includes(error?.code)) return 404
  if (['admin_required', 'access_denied'].includes(error?.code)) return 403
  if (['preview_hash_mismatch', 'confirmation_required', 'source_target_not_eligible', 'dispatch_not_retryable', 'dispatch_not_cancellable', 'uncertain_requires_reconciliation', 'pending_cancel_not_applicable', 'pending_cancel_job_active', 'no_failed_targets', 'idempotency_key_conflict'].includes(error?.code)) return 409
  return 400
}

function sendError(res, error) {
  return res.status(statusForError(error)).json({ ok: false, error: error?.code || error?.message || 'admin_strategy_trade_failed', details: error?.details || {} })
}

router.get('/admin/strategy-trades/capabilities', authMiddleware, adminOnly, (_req, res) => {
  res.json({ ok: true, enabled: true, supported_entry_methods: [...ADMIN_STRATEGY_TRADE_ENTRY_METHODS] })
})

router.post('/admin/strategy-trades/preview', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await buildAdminStrategyTradePreview(req.user.id, req.body || {}, req.headers || {})
    res.json({ ok: true, ...result })
  } catch (error) { sendError(res, error) }
})

router.post('/admin/strategy-trades', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await createAdminStrategyTradeDispatch(req.user.id, req.body || {}, req.headers || {})
    await logAudit({ userId:req.user.id, action:'admin_strategy_trade_dispatch_create', targetType:'admin_strategy_trade_dispatch', targetId:result?.id, detail:JSON.stringify({ strategy_id:req.body?.strategy_id, symbol:req.body?.symbol, direction:req.body?.direction }) })
    res.status(201).json({ ok: true, dispatch: result })
  } catch (error) { sendError(res, error) }
})

router.get('/admin/strategy-trades/:id', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await getAdminStrategyTradeDispatch(req.params.id, req.user.id)
    if (!result) return res.status(404).json({ ok: false, error: 'dispatch_not_found' })
    res.json({ ok: true, dispatch: result })
  } catch (error) { sendError(res, error) }
})

router.post('/admin/strategy-trades/:id/retry', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await retryAdminStrategyTradeDispatch(req.user.id, req.params.id)
    await logAudit({ userId:req.user.id, action:'admin_strategy_trade_dispatch_retry', targetType:'admin_strategy_trade_dispatch', targetId:req.params.id })
    res.json({ ok: true, dispatch: result })
  } catch (error) { sendError(res, error) }
})

router.post('/admin/strategy-trades/:id/cancel', authMiddleware, adminOnly, async (req, res) => {
  try {
    const result = await cancelAdminStrategyTradeDispatch(req.user.id, req.params.id)
    await logAudit({ userId:req.user.id, action:'admin_strategy_trade_dispatch_cancel', targetType:'admin_strategy_trade_dispatch', targetId:req.params.id })
    res.json({ ok: true, dispatch: result })
  } catch (error) { sendError(res, error) }
})

// This is intentionally separate from :id/cancel: the legacy endpoint only
// cancels targets which have not reached the Bridge.  These endpoints operate
// on real pending tickets created by the dispatch and never close positions.
router.get('/admin/strategy-trades/:id/pending-cancel-preview', authMiddleware, adminOnly, async (req, res) => {
  try {
    const preview = await buildAdminStrategyPendingCancelPreview(req.user.id, req.params.id)
    res.json({ ok:true, preview, ...preview })
  } catch (error) { sendError(res, error) }
})

router.post('/admin/strategy-trades/:id/pending-cancel-jobs', authMiddleware, adminOnly, async (req, res) => {
  try {
    const job = await createAdminStrategyPendingCancelJob(req.user.id, req.params.id, req.body || {}, req.headers || {})
    await logAudit({ userId:req.user.id, action:'admin_strategy_pending_cancel_job_created', targetType:'admin_strategy_pending_cancel_job', targetId:job.id,
      detail:JSON.stringify({ dispatch_id:job.dispatch_id, source_signal_id:job.source_signal_id, eligible_target_count:job.eligible_target_count }) })
    res.status(202).json({ ok:true, job, pending_cancel_job:job })
  } catch (error) { sendError(res, error) }
})

router.get('/admin/strategy-trades/pending-cancel-jobs/:jobId', authMiddleware, adminOnly, async (req, res) => {
  try {
    const job = await getAdminStrategyPendingCancelJob(req.params.jobId, req.user.id)
    if (!job) return res.status(404).json({ ok:false, error:'pending_cancel_job_not_found' })
    res.json({ ok:true, job, pending_cancel_job:job })
  } catch (error) { sendError(res, error) }
})

router.post('/admin/strategy-trades/pending-cancel-jobs/:jobId/retry-failed', authMiddleware, adminOnly, async (req, res) => {
  try {
    const job = await retryFailedAdminStrategyPendingCancelJob(req.user.id, req.params.jobId, req.body || {})
    await logAudit({ userId:req.user.id, action:'admin_strategy_pending_cancel_job_retry_failed', targetType:'admin_strategy_pending_cancel_job', targetId:job.id,
      detail:JSON.stringify({ preview_hash:req.body?.preview_hash }) })
    res.status(202).json({ ok:true, job, pending_cancel_job:job })
  } catch (error) { sendError(res, error) }
})

export default router
