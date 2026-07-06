import { queryOne, queryRun, queryAll, beijingNow } from '../db.js'
import { adapters, getAdapter } from './chains/index.js'

const CONFIRM_POLL_MS = 15_000
const EXPIRY_POLL_MS = 30_000
const FALLBACK_POLL_MS = 60_000

let confirmTimer = null
let expiryTimer = null
let fallbackTimer = null
let started = false

export function formatUsdtAmount(amount) {
  return parseFloat(amount).toFixed(2)
}

export async function addWatchAddress({ orderId, userId, chain, address, expectedAmount, expiresAt }) {
  const { insertId } = await queryRun(
    `INSERT INTO crypto_watch_list (order_id, user_id, chain, address, expected_amount, status, required_confirmations, expires_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [orderId, userId, chain, address, expectedAmount, getAdapter(chain).getRequiredConfirmations(), expiresAt]
  )
  return insertId
}

export async function removeWatchAddress(id) {
  await queryRun('DELETE FROM crypto_watch_list WHERE id = ?', [id])
}

async function checkConfirmations() {
  try {
    const rows = await queryAll(
      `SELECT id, chain, tx_hash, status, order_id, user_id, required_confirmations
       FROM crypto_watch_list WHERE status = 'confirming' AND tx_hash IS NOT NULL`,
      []
    )

    for (const row of rows) {
      const adapter = getAdapter(row.chain)
      const confirmations = await adapter.getConfirmations(row.tx_hash)

      if (confirmations >= row.required_confirmations) {
        await queryRun(
          `UPDATE crypto_watch_list SET confirmations = ?, status = 'confirmed' WHERE id = ?`,
          [confirmations, row.id]
        )
        await activateMembership(row.order_id, row.user_id)
      } else {
        await queryRun(
          `UPDATE crypto_watch_list SET confirmations = ?, status = 'confirming' WHERE id = ?`,
          [confirmations, row.id]
        )
      }
    }
  } catch (err) {
    console.error('[Monitor] Confirmation check error:', err.message)
  }
}

async function activateMembership(orderId, userId) {
  const order = await queryOne('SELECT plan, period FROM orders WHERE order_id = ?', [orderId])
  if (!order) return

  const now = beijingNow()
  await queryRun(
    `UPDATE orders SET status = 'paid', paid_at = ? WHERE order_id = ?`,
    [now, orderId]
  )

  const expiresAt = calculatePlanExpiry(order.period)
  await queryRun(
    `UPDATE users SET plan = ?, plan_expires_at = ?, updated_at = ? WHERE id = ?`,
    [order.plan, expiresAt, now, userId]
  )

  console.log(`[Monitor] Membership activated: user ${userId} -> ${order.plan} (expires ${expiresAt})`)
}

function calculatePlanExpiry(period) {
  const now = new Date(Date.now() + 8 * 3600_000)
  if (period === 'yearly') {
    now.setFullYear(now.getFullYear() + 1)
  } else {
    now.setMonth(now.getMonth() + 1)
  }
  return now.toISOString().replace('T', ' ').substring(0, 19)
}

async function checkExpiry() {
  try {
    const now = beijingNow()
    const { changes } = await queryRun(
      `UPDATE crypto_watch_list SET status = 'expired' WHERE status IN ('pending', 'confirming') AND expires_at < ?`,
      [now]
    )
    if (changes > 0) {
      console.log(`[Monitor] Expired ${changes} watch_list records`)
    }
  } catch (err) {
    console.error('[Monitor] Expiry check error:', err.message)
  }
}

async function fallbackPoll() {
  try {
    for (const chainName of Object.keys(adapters)) {
      const rows = await queryAll(
        `SELECT id, chain, address, expected_amount, status, order_id, user_id, required_confirmations
         FROM crypto_watch_list WHERE status = 'pending' AND chain = ?`,
        [chainName]
      )

      if (rows.length === 0) continue

      const adapter = getAdapter(chainName)
      const filter = adapter.buildTransferEventFilter(rows.map(r => r.address))

      for (const row of rows) {
        try {
          const tx = await adapter.getTransaction(row.tx_hash || '')
          if (tx && tx.status === 'success') {
            const amount = formatUsdtAmount(tx.value / 1e6)
            const expected = parseFloat(row.expected_amount)
            const tolerance = expected * 0.01

            if (Math.abs(parseFloat(amount) - expected) <= tolerance) {
              await queryRun(
                `UPDATE crypto_watch_list SET tx_hash = ?, status = 'confirming' WHERE id = ?`,
                [tx.hash, row.id]
              )
            }
          }
        } catch {
          // Transaction not found yet, continue polling
        }
      }
    }
  } catch (err) {
    console.error('[Monitor] Fallback poll error:', err.message)
  }
}

export function startMonitor() {
  if (started) return
  started = true

  confirmTimer = setInterval(checkConfirmations, CONFIRM_POLL_MS)
  expiryTimer = setInterval(checkExpiry, EXPIRY_POLL_MS)
  fallbackTimer = setInterval(fallbackPoll, FALLBACK_POLL_MS)

  console.log('[Monitor] Started')
}

export function stopMonitor() {
  if (!started) return
  started = false

  if (confirmTimer) clearInterval(confirmTimer)
  if (expiryTimer) clearInterval(expiryTimer)
  if (fallbackTimer) clearInterval(fallbackTimer)

  confirmTimer = null
  expiryTimer = null
  fallbackTimer = null

  console.log('[Monitor] Stopped')
}
