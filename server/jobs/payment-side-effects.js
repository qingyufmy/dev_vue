import { queryRun, withTransaction } from '../db.js'
import { processReferralCommission } from '../utils.js'

const DEFAULT_INTERVAL_MS = 30_000
const DEFAULT_BATCH_SIZE = 25

let workerTimer = null
let kickTimer = null
let workerRunning = false

function rowsFrom(result) {
  if (Array.isArray(result) && Array.isArray(result[0])) return result[0]
  return Array.isArray(result) ? result : []
}

function affectedRows(result) {
  const header = Array.isArray(result) ? result[0] : result
  return Number(header?.affectedRows ?? header?.changes ?? 0)
}

export async function enqueuePaymentSideEffect(run, { orderId, userId }) {
  const id = String(orderId || '').trim()
  const uid = Number(userId)
  if (!id || !Number.isInteger(uid) || uid <= 0) throw new Error('invalid_payment_side_effect')
  await run(
    `INSERT INTO payment_side_effects (order_id, user_id, status, next_attempt_at, created_at, updated_at)
     VALUES (?, ?, 'pending', NOW(), NOW(), NOW())
     ON DUPLICATE KEY UPDATE user_id = VALUES(user_id),
       status = IF(status = 'completed', status, 'pending'),
       next_attempt_at = IF(status = 'completed', next_attempt_at, NOW()),
       updated_at = NOW()`,
    [id, uid],
  )
}

export async function claimPaymentSideEffect() {
  return withTransaction(async run => {
    const rows = rowsFrom(await run(
      `SELECT id, order_id, user_id, attempt_count
       FROM payment_side_effects
       WHERE (status IN ('pending', 'retry') AND next_attempt_at <= NOW())
          OR (status = 'processing' AND locked_at < DATE_SUB(NOW(), INTERVAL 5 MINUTE))
       ORDER BY id ASC LIMIT 1 FOR UPDATE`,
    ))
    const effect = rows[0]
    if (!effect) return null
    const claimed = await run(
      `UPDATE payment_side_effects
       SET status = 'processing', attempt_count = attempt_count + 1,
         locked_at = NOW(), last_error = NULL, updated_at = NOW()
       WHERE id = ?`,
      [effect.id],
    )
    if (affectedRows(claimed) !== 1) return null
    return { ...effect, attempt_count:Number(effect.attempt_count || 0) + 1 }
  })
}

export async function completePaymentSideEffect(effect) {
  return withTransaction(async run => {
    const rows = rowsFrom(await run(
      `SELECT order_id, user_id, plan, plan_label, period, amount_confirmed, status
       FROM orders WHERE order_id = ? FOR UPDATE`,
      [effect.order_id],
    ))
    const order = rows[0]
    if (!order || order.status !== 'paid') throw new Error('payment_order_not_paid')
    if (Number(order.user_id) !== Number(effect.user_id)) throw new Error('payment_side_effect_user_mismatch')

    await run(
      `INSERT IGNORE INTO notifications (user_id, type, title, message, dedupe_key)
       VALUES (?, 'system', '支付成功', ?, ?)`,
      [order.user_id, `您已成功开通 ${order.plan_label || order.plan} 会员。`, `payment:${order.order_id}:success`],
    )
    await processReferralCommission(
      order.user_id,
      order.amount_confirmed,
      order.plan,
      order.plan_label,
      order.period,
      order.order_id,
      { run },
    )
    const completed = await run(
      `UPDATE payment_side_effects
       SET status = 'completed', completed_at = NOW(), locked_at = NULL,
         last_error = NULL, updated_at = NOW()
       WHERE id = ? AND status = 'processing'`,
      [effect.id],
    )
    if (affectedRows(completed) !== 1) throw new Error('payment_side_effect_completion_conflict')
    return { status:'completed', orderId:order.order_id }
  })
}

export async function retryPaymentSideEffect(effect, error) {
  const message = String(error?.message || error || 'payment_side_effect_failed').slice(0, 1000)
  await queryRun(
    `UPDATE payment_side_effects
     SET status = 'retry', next_attempt_at = DATE_ADD(NOW(), INTERVAL 1 MINUTE),
       locked_at = NULL, last_error = ?, updated_at = NOW()
     WHERE id = ? AND status = 'processing'`,
    [message, effect.id],
  )
}

export async function drainPaymentSideEffects({ batchSize = DEFAULT_BATCH_SIZE } = {}) {
  if (workerRunning) return { status:'already_running', processed:0, failed:0 }
  workerRunning = true
  let processed = 0
  let failed = 0
  try {
    const limit = Math.min(100, Math.max(1, Number(batchSize) || DEFAULT_BATCH_SIZE))
    for (let index = 0; index < limit; index += 1) {
      const effect = await claimPaymentSideEffect()
      if (!effect) break
      try {
        await completePaymentSideEffect(effect)
        processed += 1
      } catch (error) {
        failed += 1
        await retryPaymentSideEffect(effect, error)
        console.error(`[PaymentSideEffects] order=${effect.order_id} failed:`, error.message)
      }
    }
    return { status:'completed', processed, failed }
  } finally {
    workerRunning = false
  }
}

export function schedulePaymentSideEffects() {
  if (kickTimer) return
  kickTimer = setTimeout(() => {
    kickTimer = null
    void drainPaymentSideEffects().catch(error => {
      console.error('[PaymentSideEffects] Immediate run failed:', error.message)
    })
  }, 0)
  kickTimer.unref?.()
}

export function startPaymentSideEffectWorker() {
  if (workerTimer) return workerTimer
  schedulePaymentSideEffects()
  workerTimer = setInterval(() => {
    void drainPaymentSideEffects().catch(error => {
      console.error('[PaymentSideEffects] Cycle failed:', error.message)
    })
  }, DEFAULT_INTERVAL_MS)
  workerTimer.unref?.()
  return workerTimer
}

export function stopPaymentSideEffectWorker() {
  if (workerTimer) clearInterval(workerTimer)
  if (kickTimer) clearTimeout(kickTimer)
  workerTimer = null
  kickTimer = null
}
