import crypto from 'node:crypto'
import { beijingAfter, beijingNow, queryAll, queryOne, queryRun, withTransaction } from '../db.js'
import { sendBridgeCommand, getBridgeGeneration, isBridgeAlive } from '../bridge-ws.js'
import { mt5Bridge } from '../routes/ai/market-data.js'
import {
  ADMIN_SYSTEM_POSITION_MAGIC,
  validateAdminSystemPositionTarget,
  inventoryExpectedState,
} from '../services/admin-system-position-targets.js'
import { acquireAccountSymbolInventoryLock, releaseAccountSymbolInventoryLock } from '../services/account-symbol-inventory-lock.js'

const COMMAND_TIMEOUT_MS = 20_000
const JOB_STALE_MS = 2 * 60 * 1000
const ACTIVE_JOB_STATUSES = ['queued', 'running', 'uncertain', 'reconciling']
let workerTimer = null
let workerRunning = false

function text(value) { return String(value ?? '').trim() }

function parseJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value
  try { return value ? JSON.parse(value) : fallback } catch { return fallback }
}

function errorCode(error, fallback = 'admin_position_close_failed') {
  return text(error?.code || error?.reason || error?.message || fallback).slice(0, 128)
}

function targetStatusTerminal(status) {
  return ['succeeded', 'failed', 'skipped'].includes(text(status))
}

function operationId(target) {
  return text(target.operation_id) || `admin-position-close:${Number(target.job_id)}:${Number(target.id)}`
}

async function claimTarget(target, expectedStatuses = ['pending']) {
  const token = crypto.randomUUID()
  const now = beijingNow()
  const expires = beijingAfter(120_000)
  return withTransaction(async run => {
    const [rows] = await run('SELECT * FROM admin_position_close_targets WHERE id = ? AND job_id = ? FOR UPDATE', [Number(target.id), Number(target.job_id)])
    const current = rows?.[0]
    if (!current || !expectedStatuses.includes(text(current.status))) return null
    const jobFence = target.job_lease_token ? ` AND EXISTS (SELECT 1 FROM admin_position_close_jobs jobs
      WHERE jobs.id = ? AND jobs.status = 'running' AND jobs.lease_token = ?)` : ''
    const updateParams = [current.status === 'uncertain' || current.status === 'reconciling' ? 'reconciling' : 'sending', token, expires, now, Number(target.id), Number(target.job_id), current.status]
    if (target.job_lease_token) updateParams.push(Number(target.job_id), String(target.job_lease_token))
    const [result] = await run(`UPDATE admin_position_close_targets SET status = ?, attempt_count = attempt_count + 1,
      lease_token = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND job_id = ? AND status = ?${jobFence}`, updateParams)
    if (!result?.affectedRows) return null
    return { ...current, status: current.status === 'uncertain' || current.status === 'reconciling' ? 'reconciling' : 'sending', lease_token:token, lease_expires_at:expires, attempt_count:Number(current.attempt_count || 0) + 1 }
  })
}

async function renewJobLease(jobId, leaseToken) {
  if (!leaseToken) return true
  const now = beijingNow()
  const expires = beijingAfter(120_000)
  const result = await queryRun(`UPDATE admin_position_close_jobs SET lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND status = 'running' AND lease_token = ?`, [expires, now, Number(jobId), String(leaseToken)])
  return Number(result?.changes || 0) > 0
}

async function markTarget(target, status, fields = {}) {
  const now = beijingNow()
  const allowed = new Set(['pending', 'sending', 'uncertain', 'reconciling', 'succeeded', 'failed', 'skipped'])
  if (!allowed.has(status)) throw new Error(`invalid_close_target_status:${status}`)
  const updates = ['status = ?', 'updated_at = ?']; const params = [status, now]
  const columns = new Set(['last_result_json', 'error_code', 'error_message', 'send_started_at', 'send_finished_at', 'reconcile_started_at', 'completed_at', 'lease_token', 'lease_expires_at'])
  for (const [column, value] of Object.entries(fields)) {
    if (!columns.has(column)) continue
    updates.push(`${column} = ?`); params.push(value)
  }
  if (['succeeded', 'failed', 'skipped'].includes(status)) {
    updates.push('completed_at = COALESCE(completed_at, ?)'); params.push(now)
    updates.push('lease_token = NULL', 'lease_expires_at = NULL')
  }
  params.push(Number(target.job_id), Number(target.id))
  const leaseClause = target.lease_token ? ' AND lease_token = ?' : ''
  if (target.lease_token) params.push(String(target.lease_token))
  const result = await queryRun(`UPDATE admin_position_close_targets SET ${updates.join(', ')} WHERE job_id = ? AND id = ?${leaseClause}`, params)
  return Number(result?.changes || 0) > 0
}

async function loadTarget(targetId) {
  return queryOne('SELECT * FROM admin_position_close_targets WHERE id = ? LIMIT 1', [Number(targetId)])
}

async function reconcileTarget(target, { bridge = mt5Bridge } = {}) {
  const claimed = await claimTarget(target, ['uncertain', 'reconciling'])
  if (!claimed) return { status:'skipped', reason:'target_claim_lost' }
  const current = { ...target, ...claimed }
  await queryRun('UPDATE admin_position_close_targets SET reconcile_started_at = ?, updated_at = ? WHERE id = ? AND lease_token = ?', [beijingNow(), beijingNow(), Number(current.id), claimed.lease_token])
  const validation = await validateAdminSystemPositionTarget(current, { bridge, requireBridge:false })
  if (!validation.ok && validation.reason === 'position_not_found') {
    await markTarget(current, 'succeeded', { last_result_json:JSON.stringify({ status:'succeeded', reconciled:true, reason:'inventory_absent' }) })
    return { status:'succeeded', reconciled:true }
  }
  if (!validation.ok) {
    await markTarget(current, 'uncertain', { error_code:validation.reason, error_message:validation.reason, last_result_json:JSON.stringify({ status:'uncertain', reconciled:true, reason:validation.reason }) })
    return { status:'uncertain', reason:validation.reason }
  }
  await markTarget(current, 'uncertain', { error_code:'position_still_present', error_message:'inventory_position_still_present', last_result_json:JSON.stringify({ status:'uncertain', reconciled:true, position:validation.position }) })
  return { status:'uncertain', reason:'position_still_present' }
}

export async function executeAdminPositionCloseTarget(target, { bridge = mt5Bridge, command = sendBridgeCommand } = {}) {
  if (['uncertain', 'reconciling'].includes(text(target.status))) return reconcileTarget(target, { bridge })
  const claimed = await claimTarget(target, ['pending'])
  if (!claimed) return { status:'skipped', reason:'target_claim_lost' }
  const current = { ...target, ...claimed }
  const validation = await validateAdminSystemPositionTarget(current, { bridge, requireBridge:true })
  if (!validation.ok) {
    const status = validation.reason === 'position_not_found' ? 'skipped' : 'failed'
    await markTarget(current, status, { error_code:validation.reason, error_message:validation.reason,
      last_result_json:JSON.stringify({ status, reason:validation.reason }) })
    return { status, reason:validation.reason }
  }
  let lock = null
  try {
    lock = await acquireAccountSymbolInventoryLock(current.user_id, current.symbol)
    if (!lock?.token) {
      await markTarget(current, 'failed', { error_code:'close_inventory_lock_busy', error_message:'close_inventory_lock_busy' })
      return { status:'failed', reason:'close_inventory_lock_busy' }
    }
    const started = beijingNow()
    await queryRun('UPDATE admin_position_close_targets SET send_started_at = ?, updated_at = ? WHERE id = ? AND lease_token = ?', [started, started, Number(current.id), claimed.lease_token])
    const expectedState = {
      broker_server_key: current.broker_server_key,
      login_account: current.login_account,
      ...inventoryExpectedState(validation.position),
      magic: ADMIN_SYSTEM_POSITION_MAGIC,
    }
    const result = await command(current.user_id, 'close_system_position', {
      operation_id: operationId(current),
      ticket:current.ticket,
      expected_state:expectedState,
    }, COMMAND_TIMEOUT_MS, { noFallback:true, expectedGeneration:validation.generation })
    const finished = beijingNow()
    await queryRun('UPDATE admin_position_close_targets SET send_finished_at = ?, last_result_json = ?, updated_at = ? WHERE id = ? AND lease_token = ?', [finished, JSON.stringify(result || {}), finished, Number(current.id), claimed.lease_token])
    // A Bridge ACK alone never closes the ledger.  Read the authoritative
    // inventory after every ACK; disappearance is the only success proof.
    const after = await validateAdminSystemPositionTarget(current, { bridge, requireBridge:false })
    if (!after.ok && after.reason === 'position_not_found') {
      await markTarget(current, 'succeeded', { last_result_json:JSON.stringify({ ...(result || {}), status:'succeeded', inventory_confirmed:true }) })
      return { status:'succeeded', inventory_confirmed:true, result }
    }
    await markTarget(current, 'uncertain', {
      error_code:result?.status === 'success' ? 'inventory_position_still_present' : 'bridge_ack_not_success',
      error_message:result?.message || result?.error || 'inventory_position_still_present',
      last_result_json:JSON.stringify({ result:result || null, inventory:after?.position || null }),
    })
    return { status:'uncertain', result }
  } catch (error) {
    await markTarget(current, 'uncertain', { error_code:errorCode(error), error_message:text(error?.message || errorCode(error)), last_result_json:JSON.stringify({ status:'uncertain', error:errorCode(error) }) })
    return { status:'uncertain', reason:errorCode(error) }
  } finally {
    if (lock?.token) await releaseAccountSymbolInventoryLock(lock.key, lock.token).catch(() => {})
  }
}

async function finalizeJob(jobId, leaseToken = null) {
  const counts = await queryOne(`SELECT
      SUM(status = 'succeeded') AS succeeded,
      SUM(status = 'failed') AS failed,
      SUM(status = 'skipped') AS skipped,
      SUM(status IN ('uncertain','reconciling','sending')) AS uncertain
    FROM admin_position_close_targets WHERE job_id = ?`, [Number(jobId)])
  const succeeded = Number(counts?.succeeded || 0)
  const failed = Number(counts?.failed || 0)
  const skipped = Number(counts?.skipped || 0)
  const uncertain = Number(counts?.uncertain || 0)
  const total = succeeded + failed + skipped + uncertain
  const status = uncertain > 0 ? 'uncertain' : failed > 0 ? (succeeded > 0 ? 'partial' : 'failed') : 'completed'
  const now = beijingNow()
  const leaseClause = leaseToken ? ' AND lease_token = ?' : ''
  const leaseParams = leaseToken ? [String(leaseToken)] : []
  await queryRun(`UPDATE admin_position_close_jobs SET status = ?, target_count = ?, succeeded_target_count = ?,
      failed_target_count = ?, skipped_target_count = ?, uncertain_target_count = ?,
      completed_at = CASE WHEN ? IN ('completed','partial','failed') THEN COALESCE(completed_at, ?) ELSE NULL END,
      lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?${leaseClause}`, [status, total, succeeded, failed, skipped, uncertain, status, now, now, Number(jobId), ...leaseParams])
  return { status, succeeded, failed, skipped, uncertain }
}

async function processCloseJob(job) {
  const targets = await queryAll(`SELECT * FROM admin_position_close_targets WHERE job_id = ?
    AND status IN ('pending','uncertain','reconciling')
    ORDER BY CASE WHEN target_role = 'subscriber' THEN 0 ELSE 1 END, target_order, id`, [Number(job.id)])
  const results = []
  for (const target of targets) {
    if (!(await renewJobLease(job.id, job.lease_token))) return { status:'lease_lost', results }
    const result = await executeAdminPositionCloseTarget({ ...target, job_lease_token:job.lease_token }).catch(error => ({ status:'uncertain', reason:errorCode(error) }))
    results.push({ id:Number(target.id), status:result.status, reason:result.reason || null })
    if (!(await renewJobLease(job.id, job.lease_token))) return { status:'lease_lost', results }
  }
  return { ...(await finalizeJob(job.id, job.lease_token)), results }
}

async function recoverStaleCloseJobs() {
  const now = beijingNow()
  await queryRun(`UPDATE admin_position_close_targets targets
    JOIN admin_position_close_jobs jobs ON jobs.id = targets.job_id
    SET targets.status = CASE WHEN targets.status = 'sending' THEN 'uncertain' ELSE targets.status END,
      targets.lease_token = NULL, targets.lease_expires_at = NULL, targets.updated_at = ?
    WHERE jobs.status = 'running' AND jobs.updated_at < DATE_SUB(NOW(), INTERVAL 2 MINUTE)
      AND targets.status IN ('sending','reconciling')`, [now])
  await queryRun(`UPDATE admin_position_close_jobs SET status = CASE WHEN status = 'running' THEN 'uncertain' ELSE status END,
      lease_token = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE status = 'running' AND updated_at < DATE_SUB(NOW(), INTERVAL 2 MINUTE)`, [now])
}

async function claimJob(jobId) {
  const token = crypto.randomUUID()
  const now = beijingNow()
  const expires = beijingAfter(120_000)
  const result = await queryRun(`UPDATE admin_position_close_jobs SET status = 'running',
      started_at = COALESCE(started_at, ?), lease_token = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status IN (?, ?, ?, ?)
        AND (lease_expires_at IS NULL OR lease_expires_at < ? OR lease_token = ?)`, [now, token, expires, now, Number(jobId), ...ACTIVE_JOB_STATUSES, now, token])
  return result?.changes ? { token, expires } : null
}

export async function runAdminPositionCloseWorkerOnce({ limit = 10 } = {}) {
  if (workerRunning) return { busy:true, processed:0 }
  workerRunning = true
  try {
    await recoverStaleCloseJobs().catch(error => console.error('[AdminPositionCloseWorker] stale recovery:', error.message))
    const rows = await queryAll(`SELECT * FROM admin_position_close_jobs WHERE status IN (?, ?, ?, ?)
      ORDER BY updated_at, id LIMIT ?`, [...['queued', 'uncertain', 'reconciling', 'running'], Math.max(1, Math.min(50, Number(limit) || 10))])
    const results = []
    for (const row of rows) {
      const claimed = await claimJob(row.id)
      if (!claimed) continue
      results.push({ id:Number(row.id), ...(await processCloseJob({ ...row, status:'running', lease_token:claimed.token })) })
    }
    return { processed:results.length, results }
  } finally { workerRunning = false }
}

export function startAdminPositionCloseWorker(intervalMs = 5_000) {
  if (workerTimer) return workerTimer
  workerTimer = setInterval(() => runAdminPositionCloseWorkerOnce().catch(error => console.error('[AdminPositionCloseWorker]', error.message)), Math.max(1_000, Number(intervalMs) || 5_000))
  workerTimer.unref?.()
  runAdminPositionCloseWorkerOnce().catch(error => console.error('[AdminPositionCloseWorker]', error.message))
  return workerTimer
}

export function stopAdminPositionCloseWorker() {
  if (workerTimer) clearInterval(workerTimer)
  workerTimer = null
}

export const __adminPositionCloseWorkerTest = {
  operationId, errorCode, targetStatusTerminal, markTarget, finalizeJob, processCloseJob,
}
