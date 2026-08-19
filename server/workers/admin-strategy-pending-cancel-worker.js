import crypto from 'node:crypto'
import { beijingAfter, beijingNow, queryAll, queryOne, queryRun, withTransaction } from '../db.js'
import { getBridgeGeneration, isBridgeAlive, isTradeEnabled } from '../bridge-ws.js'
import { mt5Bridge } from '../routes/ai/market-data.js'
import { stripBrokerSuffix } from '../routes/ai/utils.js'
import { acquireAccountSymbolInventoryLock, releaseAccountSymbolInventoryLock } from '../services/account-symbol-inventory-lock.js'
import { ADMIN_STRATEGY_TRADE_MAGIC } from '../services/admin-strategy-trades.js'

const INTERVAL_MS = 5_000
const LEASE_MS = 120_000
let workerTimer = null
let workerRunning = false

function text(value) { return String(value ?? '').trim() }
function json(value, fallback = {}) {
  if (value && typeof value === 'object') return value
  try { return value ? JSON.parse(value) : fallback } catch { return fallback }
}
function code(error, fallback = 'admin_pending_cancel_failed') { return text(error?.code || error?.reason || error?.message || fallback).slice(0, 128) }
function ref(value) { return text(value) || null }
function symbol(value) { return stripBrokerSuffix(text(value)).toUpperCase() }
function sameVolume(left, right) { return Math.abs(Number(left || 0) - Number(right || 0)) <= 1e-8 }
function inventoryOrders(inventory) { return Array.isArray(inventory?.pending_orders) ? inventory.pending_orders : Array.isArray(inventory?.pending) ? inventory.pending : [] }
function inventoryPositions(inventory) { return Array.isArray(inventory?.positions) ? inventory.positions : [] }
function inventoryTicket(item) { return ref(item?.ticket || item?.order_id || item?.pending_ticket) }
function pendingType(item) {
  const explicit = text(item?.pending_type || item?.order_type).toLowerCase()
  if (explicit) return explicit
  return ({ 2:'buy_limit', 3:'sell_limit', 4:'buy_stop', 5:'sell_stop', 6:'buy_stop_limit', 7:'sell_stop_limit' })[Number(item?.type)] || ''
}
function pendingSide(item) {
  const direct = text(item?.side || item?.direction).toLowerCase()
  if (direct === 'buy' || direct === 'sell') return direct
  const kind = pendingType(item)
  return kind.startsWith('buy') ? 'buy' : kind.startsWith('sell') ? 'sell' : ''
}

function accountMatches(inventory, target) {
  return inventory?.status === 'success' && inventory?.account
    && text(inventory.account.server).toUpperCase() === text(target.broker_server_key).toUpperCase()
    && text(inventory.account.login) === text(target.login_account)
}

function expectedMatches(item, expected) {
  return inventoryTicket(item) === ref(expected.ticket)
    && symbol(item.symbol) === symbol(expected.symbol)
    && pendingSide(item) === text(expected.direction).toLowerCase()
    && (!expected.pending_type || pendingType(item) === text(expected.pending_type).toLowerCase())
    && Number(item.magic || 0) === Number(expected.magic || ADMIN_STRATEGY_TRADE_MAGIC)
    && sameVolume(item.volume, expected.volume)
}

async function claimJob(jobId) {
  const token = crypto.randomUUID()
  const now = beijingNow()
  const expires = beijingAfter(LEASE_MS)
  const result = await queryRun(`UPDATE admin_strategy_pending_cancel_jobs SET status = 'running',
      started_at = COALESCE(started_at, ?), lease_token = ?, lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND status IN ('queued', 'running', 'uncertain', 'reconciling')
      AND (lease_expires_at IS NULL OR lease_expires_at < ? OR lease_token = ?)`,
  [now, token, expires, now, Number(jobId), now, token])
  return Number(result?.changes || result?.affectedRows || 0) > 0 ? { token, expires } : null
}

async function renewJob(jobId, token) {
  const now = beijingNow(); const expires = beijingAfter(LEASE_MS)
  const result = await queryRun(`UPDATE admin_strategy_pending_cancel_jobs SET lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND status = 'running' AND lease_token = ?`, [expires, now, Number(jobId), text(token)])
  return Number(result?.changes || result?.affectedRows || 0) > 0
}

async function claimTarget(target, expectedStatuses = ['pending']) {
  const token = crypto.randomUUID(); const now = beijingNow(); const expires = beijingAfter(LEASE_MS)
  return withTransaction(async run => {
    const [rows] = await run('SELECT * FROM admin_strategy_pending_cancel_targets WHERE id = ? AND job_id = ? FOR UPDATE', [Number(target.id), Number(target.job_id)])
    const current = rows?.[0]
    if (!current || !expectedStatuses.includes(text(current.status))) return null
    const status = ['uncertain', 'reconciling'].includes(text(current.status)) ? 'reconciling' : 'sending'
    const [result] = await run(`UPDATE admin_strategy_pending_cancel_targets SET status = ?, attempt_count = attempt_count + 1,
      lease_token = ?, lease_expires_at = ?, updated_at = ? WHERE id = ? AND job_id = ? AND status = ?`,
    [status, token, expires, now, Number(target.id), Number(target.job_id), current.status])
    if (Number(result?.affectedRows || result?.changes || 0) !== 1) return null
    return { ...current, status, lease_token:token, lease_expires_at:expires, attempt_count:Number(current.attempt_count || 0) + 1 }
  })
}

async function markTarget(target, status, fields = {}) {
  const allowed = new Set(['pending', 'sending', 'uncertain', 'reconciling', 'succeeded', 'failed', 'skipped'])
  if (!allowed.has(status)) throw new Error(`invalid_pending_cancel_target_status:${status}`)
  const now = beijingNow(); const updates = ['status = ?', 'updated_at = ?']; const params = [status, now]
  const columns = new Set(['send_started_at', 'send_finished_at', 'reconcile_started_at', 'completed_at', 'last_result_json', 'error_code', 'error_message', 'lease_token', 'lease_expires_at', 'ticket', 'expected_state_json'])
  for (const [column, value] of Object.entries(fields)) {
    if (!columns.has(column)) continue
    updates.push(`${column} = ?`); params.push(value)
  }
  if (['succeeded', 'failed', 'skipped'].includes(status)) {
    updates.push('completed_at = COALESCE(completed_at, ?)', 'lease_token = NULL', 'lease_expires_at = NULL'); params.push(now)
  }
  params.push(Number(target.job_id), Number(target.id))
  const lease = target.lease_token ? ' AND lease_token = ?' : ''
  if (target.lease_token) params.push(text(target.lease_token))
  await queryRun(`UPDATE admin_strategy_pending_cancel_targets SET ${updates.join(', ')} WHERE job_id = ? AND id = ?${lease}`, params)
}

async function loadInventory(target, bridge = mt5Bridge) {
  if (!isBridgeAlive(Number(target.user_id))) return { status:'error', error:'bridge_offline' }
  if (!isTradeEnabled(Number(target.user_id))) return { status:'error', error:'trade_send_disabled' }
  return bridge(Number(target.user_id), 'system_trade_inventory', {}, { noFallback:true, timeoutMs:10_000 }).catch(error => ({ status:'error', error:code(error, 'inventory_unavailable') }))
}

function classifyInventory(target, inventory) {
  const expected = json(target.expected_state_json, {})
  if (!inventory || inventory.status !== 'success') {
    const reason = text(inventory?.error || inventory?.message || 'inventory_unavailable') || 'inventory_unavailable'
    return { status:'failed', reason }
  }
  if (!accountMatches(inventory, target)) return { status:'failed', reason:'account_identity_mismatch' }
  const orders = inventoryOrders(inventory)
  const current = orders.find(item => inventoryTicket(item) === ref(expected.ticket))
  if (current && expectedMatches(current, expected)) return { status:'active', order:current, expected }
  if (current) return { status:'failed', reason:'pending_identity_mismatch', order:current, expected }
  const position = inventoryPositions(inventory).find(item => inventoryTicket(item) === ref(expected.ticket)
    && symbol(item.symbol) === symbol(expected.symbol)
    && text(item.type || item.direction).toLowerCase() === text(expected.direction).toLowerCase()
    && Number(item.magic || 0) === Number(expected.magic || ADMIN_STRATEGY_TRADE_MAGIC))
  if (position) return { status:'filled', position, expected }
  return { status:'absent', expected }
}

async function updateOutcomeTerminal(target, result) {
  if (!target.outcome_id || !['succeeded', 'skipped'].includes(result.status)) return
  if (result.status === 'succeeded') {
    await queryRun(`UPDATE signal_outcomes SET status = 'cancelled', attribution_status = 'not_filled',
      last_scan_at = ?, updated_at = ? WHERE id = ? AND position_id IS NULL AND pending_ticket = ?`,
    [beijingNow(), beijingNow(), Number(target.outcome_id), ref(target.ticket)])
    await queryRun(`UPDATE ai_signals SET pending_state = 'cancelled', is_executed = 0
      WHERE id = ? AND pending_ticket = ? AND pending_state = 'pending'`, [Number(target.signal_id), ref(target.ticket)])
    if (target.dispatch_target_id) {
      await queryRun(`UPDATE admin_strategy_trade_targets SET terminal_order_state = 'cancelled', updated_at = ?
        WHERE id = ? AND status = 'succeeded' AND terminal_order_kind = 'pending'`, [beijingNow(), Number(target.dispatch_target_id)])
    }
  }
}

async function reconcileTarget(target, { bridge = mt5Bridge } = {}) {
  const claimed = await claimTarget(target, ['uncertain', 'reconciling'])
  if (!claimed) return { status:'skipped', reason:'target_claim_lost' }
  const current = { ...target, ...claimed }
  await queryRun('UPDATE admin_strategy_pending_cancel_targets SET reconcile_started_at = ?, updated_at = ? WHERE id = ? AND lease_token = ?', [beijingNow(), beijingNow(), Number(current.id), claimed.lease_token])
  const inventory = await bridge(Number(current.user_id), 'system_trade_inventory', {}, { noFallback:true, timeoutMs:10_000 }).catch(() => null)
  const result = classifyInventory(current, inventory)
  if (result.status === 'absent') {
    await updateOutcomeTerminal(current, { status:'succeeded' })
    await markTarget(current, 'succeeded', { last_result_json:JSON.stringify({ status:'succeeded', reconciled:true, reason:'inventory_absent' }) })
    return { status:'succeeded', reconciled:true }
  }
  if (result.status === 'filled') {
    await markTarget(current, 'skipped', { error_code:'filled_during_cancel', error_message:'pending_filled_during_cancel', last_result_json:JSON.stringify({ status:'skipped', reconciled:true, reason:'filled_during_cancel', position:result.position }) })
    return { status:'skipped', reason:'filled_during_cancel' }
  }
  if (result.status === 'failed') {
    await markTarget(current, 'failed', { error_code:result.reason, error_message:result.reason, last_result_json:JSON.stringify({ status:'failed', reconciled:true, reason:result.reason, order:result.order || null }) })
    return { status:'failed', reason:result.reason }
  }
  await markTarget(current, 'uncertain', { error_code:'pending_still_active', error_message:'pending_still_active', last_result_json:JSON.stringify({ status:'uncertain', reconciled:true, reason:'pending_still_active', order:result.order || null }) })
  return { status:'uncertain', reason:'pending_still_active' }
}

export async function executeAdminStrategyPendingCancelTarget(target, { bridge = mt5Bridge } = {}) {
  if (['uncertain', 'reconciling'].includes(text(target.status))) return reconcileTarget(target, { bridge })
  const claimed = await claimTarget(target, ['pending'])
  if (!claimed) return { status:'skipped', reason:'target_claim_lost' }
  const current = { ...target, ...claimed }
  const inventory = await loadInventory(current, bridge)
  const before = classifyInventory(current, inventory)
  if (before.status === 'absent') {
    await markTarget(current, 'skipped', { error_code:'already_absent', error_message:'already_absent', last_result_json:JSON.stringify({ status:'skipped', reason:'already_absent' }) })
    return { status:'skipped', reason:'already_absent' }
  }
  if (before.status === 'filled') {
    await markTarget(current, 'skipped', { error_code:'filled', error_message:'filled_pending_not_cancelled', last_result_json:JSON.stringify({ status:'skipped', reason:'filled', position:before.position }) })
    return { status:'skipped', reason:'filled' }
  }
  if (before.status === 'failed') {
    await markTarget(current, 'failed', { error_code:before.reason, error_message:before.reason, last_result_json:JSON.stringify({ status:'failed', reason:before.reason }) })
    return { status:'failed', reason:before.reason }
  }
  let lock = null
  let commandStarted = false
  try {
    lock = await acquireAccountSymbolInventoryLock(current.user_id, current.symbol)
    if (!lock?.token) {
      await markTarget(current, 'failed', { error_code:'pending_cancel_inventory_lock_busy', error_message:'pending_cancel_inventory_lock_busy' })
      return { status:'failed', reason:'pending_cancel_inventory_lock_busy' }
    }
    // The preview inventory is advisory.  Once the account-symbol lock is
    // held, read the authoritative terminal state again immediately before
    // writing the Bridge command so a fill/cancel race cannot target a stale
    // ticket or accidentally become a position close.
    const lockedInventory = await loadInventory(current, bridge)
    const locked = classifyInventory(current, lockedInventory)
    if (locked.status === 'absent') {
      await markTarget(current, 'skipped', { error_code:'already_absent', error_message:'already_absent', last_result_json:JSON.stringify({ status:'skipped', reason:'already_absent_before_send' }) })
      return { status:'skipped', reason:'already_absent_before_send' }
    }
    if (locked.status === 'filled') {
      await markTarget(current, 'skipped', { error_code:'filled', error_message:'filled_pending_not_cancelled', last_result_json:JSON.stringify({ status:'skipped', reason:'filled_before_send', position:locked.position }) })
      return { status:'skipped', reason:'filled_before_send' }
    }
    if (locked.status === 'failed') {
      await markTarget(current, 'failed', { error_code:locked.reason, error_message:locked.reason, last_result_json:JSON.stringify({ status:'failed', reason:locked.reason }) })
      return { status:'failed', reason:locked.reason }
    }
    const started = beijingNow()
    await queryRun('UPDATE admin_strategy_pending_cancel_targets SET send_started_at = ?, updated_at = ? WHERE id = ? AND lease_token = ?', [started, started, Number(current.id), claimed.lease_token])
    const operationId = text(current.operation_id) || `admin-strategy-pending-cancel:${Number(current.job_id)}:${Number(current.id)}`
    // The locked inventory is the last authoritative read before issuing the
    // command.  Use its expected state (rather than the preview/before read)
    // so the Bridge fence matches the ticket and attributes we actually
    // re-validated under the account-symbol lock.
    const expectedGeneration = Number(current.bridge_generation || getBridgeGeneration(current.user_id) || 0)
    commandStarted = true
    const result = await bridge(Number(current.user_id), 'cancel_system_pending', {
      ticket:locked.expected.ticket, operation_id:operationId, expected_state:locked.expected,
    }, { noFallback:true, timeoutMs:15_000, expectedGeneration })
    const finished = beijingNow()
    await queryRun('UPDATE admin_strategy_pending_cancel_targets SET send_finished_at = ?, last_result_json = ?, updated_at = ? WHERE id = ? AND lease_token = ?', [finished, JSON.stringify(result || {}), finished, Number(current.id), claimed.lease_token])
    const afterInventory = await bridge(Number(current.user_id), 'system_trade_inventory', {}, { noFallback:true, timeoutMs:10_000 }).catch(() => null)
    const after = classifyInventory(current, afterInventory)
    if (after.status === 'absent') {
      await updateOutcomeTerminal(current, { status:'succeeded' })
      await markTarget(current, 'succeeded', { last_result_json:JSON.stringify({ result:result || null, status:'succeeded', inventory_confirmed:true }) })
      return { status:'succeeded', inventory_confirmed:true, result }
    }
    if (after.status === 'filled') {
      await markTarget(current, 'skipped', { error_code:'filled_during_cancel', error_message:'filled_during_cancel', last_result_json:JSON.stringify({ result:result || null, status:'skipped', reason:'filled_during_cancel', position:after.position }) })
      return { status:'skipped', reason:'filled_during_cancel', result }
    }
    if (after.status === 'failed') {
      await markTarget(current, 'failed', { error_code:after.reason || 'pending_identity_mismatch', error_message:after.reason || 'pending_identity_mismatch', last_result_json:JSON.stringify({ result:result || null, status:'failed', reason:after.reason }) })
      return { status:'failed', reason:after.reason || 'pending_identity_mismatch', result }
    }
    const bridgeSucceeded = result?.status === 'success'
    if (!bridgeSucceeded) {
      await markTarget(current, 'failed', { error_code:result?.error || result?.message || 'bridge_cancel_rejected', error_message:result?.message || result?.error || 'bridge_cancel_rejected', last_result_json:JSON.stringify({ result:result || null, status:'failed', pending:after.order || null }) })
      return { status:'failed', reason:result?.error || 'bridge_cancel_rejected', result }
    }
    await markTarget(current, 'uncertain', { error_code:'pending_still_active', error_message:result?.message || 'pending_still_active', last_result_json:JSON.stringify({ result:result || null, status:'uncertain', pending:after.order || null }) })
    return { status:'uncertain', reason:'pending_still_active', result }
  } catch (error) {
    const errorCode = code(error)
    const status = commandStarted ? 'uncertain' : 'failed'
    await markTarget(current, status, {
      error_code:errorCode, error_message:errorCode,
      last_result_json:JSON.stringify({ status, error:errorCode, command_started:commandStarted }),
    })
    return { status, reason:errorCode }
  } finally {
    if (lock?.token) await releaseAccountSymbolInventoryLock(lock.key, lock.token).catch(() => {})
  }
}

async function finalizeJob(jobId, leaseToken = null) {
  const counts = await queryOne(`SELECT
      SUM(status = 'succeeded') AS succeeded, SUM(status = 'failed') AS failed,
      SUM(status = 'skipped') AS skipped, SUM(status IN ('uncertain','reconciling','sending')) AS uncertain
    FROM admin_strategy_pending_cancel_targets WHERE job_id = ?`, [Number(jobId)])
  const succeeded = Number(counts?.succeeded || 0); const failed = Number(counts?.failed || 0)
  const skipped = Number(counts?.skipped || 0); const uncertain = Number(counts?.uncertain || 0)
  const total = succeeded + failed + skipped + uncertain
  const status = uncertain > 0 ? 'uncertain' : failed > 0 ? (succeeded > 0 ? 'partial' : 'failed') : 'completed'
  const now = beijingNow(); const lease = leaseToken ? ' AND lease_token = ?' : ''
  const params = [status, total, succeeded, failed, skipped, uncertain, status, now, now, Number(jobId)]
  if (leaseToken) params.push(text(leaseToken))
  await queryRun(`UPDATE admin_strategy_pending_cancel_jobs SET status = ?, target_count = ?, succeeded_target_count = ?,
      failed_target_count = ?, skipped_target_count = ?, uncertain_target_count = ?,
      completed_at = CASE WHEN ? IN ('completed','partial','failed') THEN COALESCE(completed_at, ?) ELSE NULL END,
      lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?${lease}`, params)
  return { status, succeeded, failed, skipped, uncertain }
}

async function processJob(job) {
  const targets = await queryAll(`SELECT * FROM admin_strategy_pending_cancel_targets
    WHERE job_id = ? AND (status = 'pending'
      OR (status IN ('uncertain','reconciling') AND updated_at < DATE_SUB(NOW(), INTERVAL 10 SECOND)))
    ORDER BY CASE WHEN target_role = 'subscriber' THEN 0 ELSE 1 END, target_order, id`, [Number(job.id)])
  const results = []
  for (const target of targets) {
    if (!(await renewJob(job.id, job.lease_token))) return { status:'lease_lost', results }
    const result = await executeAdminStrategyPendingCancelTarget({ ...target, job_lease_token:job.lease_token }).catch(error => ({ status:'uncertain', reason:code(error) }))
    results.push({ id:Number(target.id), status:result.status, reason:result.reason || null })
    if (!(await renewJob(job.id, job.lease_token))) return { status:'lease_lost', results }
  }
  return { ...(await finalizeJob(job.id, job.lease_token)), results }
}

async function recoverStaleJobs() {
  const now = beijingNow()
  await queryRun(`UPDATE admin_strategy_pending_cancel_targets targets
    JOIN admin_strategy_pending_cancel_jobs jobs ON jobs.id = targets.job_id
    SET targets.status = CASE WHEN targets.status = 'sending' THEN 'uncertain' ELSE targets.status END,
      targets.lease_token = NULL, targets.lease_expires_at = NULL, targets.updated_at = ?
    WHERE jobs.status = 'running' AND jobs.updated_at < DATE_SUB(NOW(), INTERVAL 2 MINUTE)
      AND targets.status IN ('sending','reconciling')`, [now])
  await queryRun(`UPDATE admin_strategy_pending_cancel_jobs SET status = CASE WHEN status = 'running' THEN 'uncertain' ELSE status END,
      lease_token = NULL, lease_expires_at = NULL, updated_at = ? WHERE status = 'running' AND updated_at < DATE_SUB(NOW(), INTERVAL 2 MINUTE)`, [now])
}

export async function runAdminStrategyPendingCancelWorkerOnce({ limit = 10 } = {}) {
  if (workerRunning) return { busy:true, processed:0 }
  workerRunning = true
  try {
    await recoverStaleJobs().catch(error => console.error('[AdminStrategyPendingCancelWorker] stale recovery:', error.message))
    const rows = await queryAll(`SELECT * FROM admin_strategy_pending_cancel_jobs
      WHERE status IN ('queued','uncertain','reconciling','running') ORDER BY updated_at, id LIMIT ?`, [Math.max(1, Math.min(50, Number(limit) || 10))])
    const results = []
    for (const row of rows) {
      const claimed = await claimJob(row.id)
      if (!claimed) continue
      results.push({ id:Number(row.id), ...(await processJob({ ...row, status:'running', lease_token:claimed.token })) })
    }
    return { processed:results.length, results }
  } finally { workerRunning = false }
}

export function startAdminStrategyPendingCancelWorker(intervalMs = INTERVAL_MS) {
  if (workerTimer) return workerTimer
  workerTimer = setInterval(() => runAdminStrategyPendingCancelWorkerOnce().catch(error => console.error('[AdminStrategyPendingCancelWorker]', error.message)), Math.max(1_000, Number(intervalMs) || INTERVAL_MS))
  workerTimer.unref?.()
  runAdminStrategyPendingCancelWorkerOnce().catch(error => console.error('[AdminStrategyPendingCancelWorker]', error.message))
  return workerTimer
}

export function stopAdminStrategyPendingCancelWorker() {
  if (workerTimer) clearInterval(workerTimer)
  workerTimer = null
}

export const __adminStrategyPendingCancelWorkerTest = {
  pendingType, pendingSide, expectedMatches, classifyInventory, code, finalizeJob, processJob,
}
