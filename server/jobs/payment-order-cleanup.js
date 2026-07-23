import { queryAll, withTransaction, beijingNow, parseBeijing } from '../db.js'

const DAY_MS = 24 * 60 * 60 * 1000
const DEFAULT_RETENTION_DAYS = 30
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000
const MAX_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000
const DEFAULT_BATCH_SIZE = 500
const MAX_BATCH_SIZE = 5000

let cleanupTimer = null
let cleanupRunning = false

function readPositiveInt(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = Number.parseInt(process.env[name] || '', 10)
  if (!Number.isFinite(value) || value < min) return fallback
  return Math.min(value, max)
}

export function getPaymentOrderCleanupConfig() {
  return {
    retentionDays: readPositiveInt('PAYMENT_EXPIRED_ORDER_RETENTION_DAYS', DEFAULT_RETENTION_DAYS, { max: 3650 }),
    intervalMs: readPositiveInt('PAYMENT_EXPIRED_ORDER_CLEANUP_INTERVAL_MS', DEFAULT_INTERVAL_MS, { min: 60_000, max: MAX_INTERVAL_MS }),
    batchSize: readPositiveInt('PAYMENT_EXPIRED_ORDER_CLEANUP_BATCH_SIZE', DEFAULT_BATCH_SIZE, { max: MAX_BATCH_SIZE }),
  }
}

function formatBeijingDateTime(date) {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  return shifted.toISOString().replace('T', ' ').slice(0, 19)
}

export function getPaymentOrderCleanupCutoff(now = beijingNow(), retentionDays = getPaymentOrderCleanupConfig().retentionDays) {
  const current = parseBeijing(now) || new Date()
  return formatBeijingDateTime(new Date(current.getTime() - retentionDays * DAY_MS))
}

function affectedRows(result) {
  const row = Array.isArray(result) ? result[0] : result
  return Number(row?.affectedRows ?? row?.changes ?? 0) || 0
}

/**
 * Delete payment orders that have been expired for the retention period.
 *
 * Paid, pending, confirming and cancelled orders are intentionally excluded.
 * The related crypto watch rows are removed only after their parent order was
 * deleted, so a concurrent status change cannot orphan an active payment.
 */
export async function purgeExpiredPaymentOrders({ now = beijingNow(), retentionDays, batchSize } = {}) {
  if (cleanupRunning) return { status: 'already_running' }

  const config = getPaymentOrderCleanupConfig()
  const safeRetentionDays = readPositiveInt('PAYMENT_EXPIRED_ORDER_RETENTION_DAYS', retentionDays ?? config.retentionDays, { max: 3650 })
  const safeBatchSize = Math.min(
    readPositiveInt('PAYMENT_EXPIRED_ORDER_CLEANUP_BATCH_SIZE', batchSize ?? config.batchSize, { max: MAX_BATCH_SIZE }),
    MAX_BATCH_SIZE,
  )
  const cutoff = getPaymentOrderCleanupCutoff(now, safeRetentionDays)

  cleanupRunning = true
  let deletedOrders = 0
  let deletedWatchRows = 0
  let batches = 0

  try {
    while (true) {
      const candidates = await queryAll(
        `SELECT id, order_id
         FROM orders
         WHERE status = 'expired'
           AND ((crypto_expires_at IS NOT NULL AND crypto_expires_at < ?)
             OR (crypto_expires_at IS NULL AND created_at < ?))
         ORDER BY id ASC
         LIMIT ?`,
        [cutoff, cutoff, safeBatchSize]
      )
      if (!candidates.length) break

      const ids = [...new Set(candidates.map(row => Number(row.id)).filter(Number.isInteger))]
      if (!ids.length) break
      const orderIds = [...new Set(candidates.map(row => row.order_id).filter(Boolean).map(String))]
      const idPlaceholders = ids.map(() => '?').join(',')
      const orderIdPlaceholders = orderIds.map(() => '?').join(',')

      const result = await withTransaction(async run => {
        const orderResult = await run(
          `DELETE FROM orders
           WHERE id IN (${idPlaceholders}) AND status = 'expired'`,
          ids,
        )
        const removedOrders = affectedRows(orderResult)

        // Only remove watch rows whose order no longer exists. This keeps a
        // watch row if a concurrent process changed the order back to active.
        let watchResult = null
        if (orderIds.length) {
          watchResult = await run(
            `DELETE FROM crypto_watch_list
             WHERE order_id IN (${orderIdPlaceholders})
               AND NOT EXISTS (
                 SELECT 1 FROM orders active_order
                 WHERE active_order.order_id = crypto_watch_list.order_id
               )`,
            orderIds,
          )
        }
        return { removedOrders, removedWatchRows: affectedRows(watchResult) }
      })

      deletedOrders += Number(result?.removedOrders || 0)
      deletedWatchRows += Number(result?.removedWatchRows || 0)
      batches += 1

      // A failed/partial delete must not cause an endless loop in one cycle.
      if (!result?.removedOrders && !result?.removedWatchRows) break
    }

    return { status: 'completed', cutoff, retentionDays: safeRetentionDays, deletedOrders, deletedWatchRows, batches }
  } finally {
    cleanupRunning = false
  }
}

export async function runPaymentOrderCleanup() {
  if (process.env.PAYMENT_EXPIRED_ORDER_CLEANUP_ENABLED === 'false') return { status: 'disabled' }
  const result = await purgeExpiredPaymentOrders()
  if (result.status === 'completed' && (result.deletedOrders || result.deletedWatchRows)) {
    console.log(`[PaymentOrderCleanup] Removed expired orders=${result.deletedOrders}, watch_rows=${result.deletedWatchRows}, batches=${result.batches}, cutoff=${result.cutoff}`)
  }
  return result
}

export function startPaymentOrderCleanup() {
  if (cleanupTimer || process.env.PAYMENT_EXPIRED_ORDER_CLEANUP_ENABLED === 'false') return cleanupTimer
  const { intervalMs } = getPaymentOrderCleanupConfig()
  const run = () => runPaymentOrderCleanup().catch(error => {
    console.error('[PaymentOrderCleanup] Cycle failed:', error.message)
  })

  // Run once after startup, then continue at a low-frequency interval. The
  // task is batch-limited and does not touch active or paid orders.
  void run()
  cleanupTimer = setInterval(run, intervalMs)
  cleanupTimer.unref?.()
  console.log(`[PaymentOrderCleanup] Scheduled every ${Math.round(intervalMs / 60_000)} minutes, retention=${getPaymentOrderCleanupConfig().retentionDays} days`)
  return cleanupTimer
}

export function stopPaymentOrderCleanup() {
  if (cleanupTimer) clearInterval(cleanupTimer)
  cleanupTimer = null
}
