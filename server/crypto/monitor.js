import { queryOne, queryRun, queryAll, beijingNow } from '../db.js'
import { adapters, getAdapter } from './chains/index.js'
import { getCryptoWalletApiKey } from './wallet.js'

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
      try {
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
            `UPDATE crypto_watch_list SET confirmations = ? WHERE id = ?`,
            [confirmations, row.id]
          )
        }
      } catch (err) {
        console.error(`[Monitor] Confirm check error for watch ${row.id}:`, err.message)
      }
    }
  } catch (err) {
    console.error('[Monitor] Confirmation batch error:', err.message)
  }
}

async function activateMembership(orderId, userId) {
  const order = await queryOne('SELECT plan, period, plan_label, amount FROM orders WHERE order_id = ?', [orderId])
  if (!order) return

  const now = beijingNow()
  await queryRun(
    `UPDATE orders SET status = 'paid', status_label = '已完成', paid_at = ? WHERE order_id = ?`,
    [now, orderId]
  )

  const expiresAt = calculatePlanExpiry(order.period)
  await queryRun(
    `UPDATE users SET plan = ?, plan_period = ?, plan_expires_at = ?, updated_at = ? WHERE id = ?`,
    [order.plan, order.period, expiresAt, now, userId]
  )

  try {
    await queryRun(
      `INSERT INTO notifications (user_id, type, title, message) VALUES (?, 'system', '支付成功', ?)`,
      [userId, `您已成功开通 ${order.plan_label || order.plan} 会员，有效期至 ${expiresAt}`]
    )
  } catch (e) {
    console.error('[Monitor] Notification error:', e.message)
  }

  if (order.amount > 0) {
    try {
      const referral = await queryOne(
        "SELECT r.id, r.referrer_id FROM referrals r WHERE r.referred_id = ? AND r.status = 'pending' ORDER BY r.created_at DESC LIMIT 1",
        [userId]
      )
      if (referral) {
        const rule = await queryOne(
          'SELECT rate_bps FROM referral_rules WHERE plan = ? AND period = ? AND enabled = 1',
          [order.plan, order.period]
        )
        const rateBps = rule ? rule.rate_bps : 1000
        const commissionDollars = order.amount * rateBps / 10000
        await queryRun(
          'UPDATE referrals SET amount_cents = ?, commission = ?, plan_label = ?, attributed_at = NOW() WHERE id = ?',
          [order.amount, commissionDollars, order.plan_label, referral.id]
        )
        await queryRun(
          'INSERT INTO notifications (user_id, type, title, message) VALUES (?, ?, ?, ?)',
          [referral.referrer_id, 'system', '💰 返佣到账', `您邀请的用户已付款 $${order.amount.toFixed(2)}，返佣 $${commissionDollars.toFixed(2)} 待审核确认`]
        )
      }
    } catch (refErr) {
      console.error('[Monitor] Referral commission error:', refErr.message)
    }
  }

  console.log(`[Monitor] Membership activated: user ${userId} -> ${order.plan} (expires ${expiresAt})`)
}

function calculatePlanExpiry(period) {
  const now = new Date(Date.now() + 8 * 3600_000)
  if (period === 'lifetime') {
    return '2099-12-31 23:59:59'
  } else if (period === 'year') {
    now.setFullYear(now.getFullYear() + 1)
  } else {
    now.setMonth(now.getMonth() + 1)
  }
  return now.toISOString().replace('T', ' ').substring(0, 19)
}

async function checkExpiry() {
  try {
    const now = beijingNow()

    const expiredWatches = await queryAll(
      `SELECT order_id FROM crypto_watch_list WHERE status IN ('pending', 'confirming') AND expires_at < ?`,
      [now]
    )

    if (expiredWatches.length > 0) {
      const ids = expiredWatches.map(r => r.order_id)
      const ph = ids.map(() => '?').join(',')
      await queryRun(`UPDATE crypto_watch_list SET status = 'expired' WHERE order_id IN (${ph})`, ids)
      await queryRun(`UPDATE orders SET status = 'expired', status_label = '已过期' WHERE order_id IN (${ph}) AND status = 'pending'`, ids)
      console.log(`[Monitor] Expired ${ids.length} orders via watch_list`)
    }

    const expiredOrders = await queryAll(
      `SELECT order_id FROM orders WHERE status = 'pending' AND crypto_expires_at IS NOT NULL AND crypto_expires_at < ?`,
      [now]
    )

    if (expiredOrders.length > 0) {
      const ids = expiredOrders.map(r => r.order_id)
      const ph = ids.map(() => '?').join(',')
      await queryRun(`UPDATE orders SET status = 'expired', status_label = '已过期' WHERE order_id IN (${ph}) AND status = 'pending'`, ids)
      await queryRun(`UPDATE crypto_watch_list SET status = 'expired' WHERE order_id IN (${ph})`, ids).catch(() => {})
      console.log(`[Monitor] Expired ${ids.length} orders via orders table`)
    }
  } catch (err) {
    console.error('[Monitor] Expiry check error:', err.message)
  }
}

async function fallbackPoll() {
  try {
    for (const chainName of Object.keys(adapters)) {
      const now = beijingNow()
      const rows = await queryAll(
        `SELECT w.id, w.chain, w.address, w.expected_amount, w.status, w.order_id, w.user_id, o.created_at
         FROM crypto_watch_list w
         JOIN orders o ON o.order_id = w.order_id
         WHERE w.status = 'pending' AND w.chain = ? AND w.expires_at > ?`,
        [chainName, now]
      )

      if (rows.length === 0) continue

      const adapter = getAdapter(chainName)
      const scanFn = SCAN_FUNCTIONS[chainName]
      if (!scanFn) continue

      for (const row of rows) {
        try {
          const tx = await scanFn(adapter, row.address, row.expected_amount, row.created_at)
          if (tx) {
            console.log(`[Monitor] Detected ${chainName} payment: ${tx.hash} (${tx.amount} USDT) for address ${row.address}`)
            await queryRun(
              `UPDATE crypto_watch_list SET tx_hash = ?, status = 'confirming', confirmations = 0 WHERE id = ?`,
              [tx.hash, row.id]
            )
          }
        } catch (err) {
          console.error(`[Monitor] Scan error for ${chainName} ${row.address}:`, err.message)
        }
      }
    }
  } catch (err) {
    console.error('[Monitor] Fallback poll error:', err.message)
  }
}

const SCAN_FUNCTIONS = {
  TRON: async (adapter, address, expectedAmount, createdAt) => {
    const apiKey = await getCryptoWalletApiKey('TRON')
    const url = `https://api.trongrid.io/v1/accounts/${address}/transactions/trc20?limit=20&contract_address=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`
    const resp = await fetch(url, {
      headers: { 'TRON-PRO-API-KEY': apiKey, 'Accept': 'application/json' }
    })
    if (!resp.ok) return null
    const data = await resp.json()
    if (!data.data) return null

    const createdMs = new Date(createdAt).getTime() - 8 * 3600_000
    for (const tx of data.data) {
      if (tx.to !== address) continue
      if (tx.block_timestamp && tx.block_timestamp < createdMs) continue
      const amount = parseInt(tx.value) / 1e6
      const expected = parseFloat(expectedAmount)
      if (Math.abs(amount - expected) / expected <= 0.01) {
        return { hash: tx.transaction_id, amount }
      }
    }
    return null
  },

  ETH: async (adapter, address, expectedAmount, createdAt) => {
    const apiKey = await getCryptoWalletApiKey('ETH')
    const url = `https://api.etherscan.io/api?module=account&action=tokentx&address=${address}&contractaddress=0xdAC17F958D2ee523a2206206994597C13D831ec7&sort=desc&page=1&offset=20&apikey=${apiKey}`
    const resp = await fetch(url)
    if (!resp.ok) return null
    const data = await resp.json()
    if (!data.result) return null

    const createdMs = new Date(createdAt).getTime() - 8 * 3600_000
    for (const tx of data.result) {
      if (tx.to.toLowerCase() !== address.toLowerCase()) continue
      if (tx.timeStamp && parseInt(tx.timeStamp) * 1000 < createdMs) continue
      const amount = parseInt(tx.value) / 1e6
      const expected = parseFloat(expectedAmount)
      if (Math.abs(amount - expected) / expected <= 0.01) {
        return { hash: tx.hash, amount }
      }
    }
    return null
  },

  BSC: async (adapter, address, expectedAmount, createdAt) => {
    const apiKey = await getCryptoWalletApiKey('BSC')
    const url = `https://api.bscscan.com/api?module=account&action=tokentx&address=${address}&contractaddress=0x55d398326f99059fF775485246999027B3197955&sort=desc&page=1&offset=20&apikey=${apiKey}`
    const resp = await fetch(url)
    if (!resp.ok) return null
    const data = await resp.json()
    if (!data.result) return null

    const createdMs = new Date(createdAt).getTime() - 8 * 3600_000
    for (const tx of data.result) {
      if (tx.to.toLowerCase() !== address.toLowerCase()) continue
      if (tx.timeStamp && parseInt(tx.timeStamp) * 1000 < createdMs) continue
      const amount = parseInt(tx.value) / 1e6
      const expected = parseFloat(expectedAmount)
      if (Math.abs(amount - expected) / expected <= 0.01) {
        return { hash: tx.hash, amount }
      }
    }
    return null
  },

  SOL: async (adapter, address, expectedAmount, createdAt) => {
    const USDT_SPL = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
    const rpcUrl = await getCryptoWalletApiKey('SOL') || 'https://api.mainnet-beta.solana.com'
    const createdMs = new Date(createdAt).getTime() - 8 * 3600_000
    const resp = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getSignaturesForAddress',
        params: [address, { limit: 20 }]
      })
    })
    if (!resp.ok) return null
    const data = await resp.json()
    if (!data.result?.value) return null

    for (const sig of data.result.value) {
      if (sig.err) continue
      if (sig.blockTime && sig.blockTime * 1000 < createdMs) continue
      const txResp = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'getTransaction',
          params: [sig.signature, { encoding: 'jsonParsed' }]
        })
      })
      if (!txResp.ok) continue
      const txData = await txResp.json()
      const tx = txData.result
      if (!tx?.meta) continue

      const preTokens = tx.meta.preTokenBalances || []
      const postTokens = tx.meta.postTokenBalances || []

      const preUsdt = preTokens.find(t => t.mint === USDT_SPL && t.owner === address)
      const postUsdt = postTokens.find(t => t.mint === USDT_SPL && t.owner === address)

      const preAmount = preUsdt ? parseFloat(preUsdt.uiTokenAmount.uiAmountString || '0') : 0
      const postAmount = postUsdt ? parseFloat(postUsdt.uiTokenAmount.uiAmountString || '0') : 0
      const diff = postAmount - preAmount

      const expected = parseFloat(expectedAmount)
      if (diff > 0 && Math.abs(diff - expected) / expected <= 0.01) {
        return { hash: sig.signature, amount: diff }
      }
    }
    return null
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
