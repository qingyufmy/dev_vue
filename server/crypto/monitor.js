import { queryOne, queryRun, queryAll, withTransaction, beijingNow, parseBeijing } from '../db.js'
import { adapters, getAdapter } from './chains/index.js'
import { getCryptoWalletApiKey } from './wallet.js'
import { calculatePlanExpiry, processReferralCommission } from '../utils.js'
import { USDT_CONTRACTS } from './constants.js'

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
          const activated = await activateMembership(row.order_id, row.user_id)
          if (activated) {
            await queryRun(
              `UPDATE crypto_watch_list SET confirmations = ?, status = 'confirmed' WHERE id = ? AND status = 'confirming'`,
              [confirmations, row.id]
            )
          }
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
  const order = await queryOne('SELECT plan, period, plan_label, amount, status FROM orders WHERE order_id = ? AND user_id = ?', [orderId, userId])
  if (!order) return
  if (order.status === 'paid') return true
  if (order.status && order.status !== 'pending') return false

  const now = beijingNow()

  // Wrap order update + user plan update in transaction to prevent crash between them
  const activated = await withTransaction(async (run) => {
    const r = await run(
      `UPDATE orders SET status = 'paid', status_label = '已完成', paid_at = ? WHERE order_id = ? AND user_id = ? AND status = 'pending'`,
      [now, orderId, userId]
    )
    const result = Array.isArray(r) ? r[0] : r
    const changes = result?.affectedRows ?? result?.changes ?? 0
    if (!changes) return false

    const user = await queryOne('SELECT plan_expires_at FROM users WHERE id = ?', [userId])
    let baseDate = null
    if (user?.plan_expires_at) {
      const currentExpiry = new Date(user.plan_expires_at + 'T23:59:59+08:00')
      if (currentExpiry > new Date()) baseDate = currentExpiry
    }
    const expiresAt = calculatePlanExpiry(order.period, baseDate)
    await run(
      `UPDATE users SET plan = ?, plan_period = ?, plan_expires_at = ?, plan_source = 'paid', updated_at = ? WHERE id = ?`,
      [order.plan, order.period, expiresAt, now, userId]
    )
    return expiresAt
  })

  if (!activated) {
    console.log(`[Monitor] Order ${orderId} already paid — skip duplicate activation`)
    return
  }

  console.log(`[Monitor] Membership activated: user ${userId} -> ${order.plan} (expires ${activated})`)
  void (async () => {
    try {
      await queryRun(
        `INSERT INTO notifications (user_id, type, title, message) VALUES (?, 'system', '支付成功', ?)`,
        [userId, `您已成功开通 ${order.plan_label || order.plan} 会员，有效期至 ${activated}`]
      )
    } catch (e) {
      console.error('[Monitor] Notification error:', e.message)
    }
    await processReferralCommission(userId, order.amount, order.plan, order.plan_label, order.period)
  })().catch(err => console.error('[Monitor] Post-payment side effect error:', err.message))

  return activated
}

async function checkExpiry() {
  try {
    const now = beijingNow()

    const expiredWatches = await queryAll(
      `SELECT order_id FROM crypto_watch_list WHERE status = 'pending' AND expires_at < ?`,
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
      `SELECT o.order_id FROM orders o
       WHERE o.status = 'pending' AND o.crypto_expires_at IS NOT NULL AND o.crypto_expires_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM crypto_watch_list w
           WHERE w.order_id = o.order_id AND w.status = 'confirming'
         )`,
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

      // 一次性取已占用的 hash 集合，防止同一笔转账被多个 watch 行认领
      const usedRows = await queryAll(
        `SELECT tx_hash FROM crypto_watch_list WHERE chain = ? AND tx_hash IS NOT NULL`,
        [chainName]
      )
      const usedHashes = new Set(usedRows.map(r => r.tx_hash))

      const rows = await queryAll(
        `SELECT w.id, w.chain, w.address, w.expected_amount, w.status, w.order_id, w.user_id, o.created_at
         FROM crypto_watch_list w
         JOIN orders o ON o.order_id = w.order_id
         WHERE w.status = 'pending' AND o.status = 'pending' AND w.chain = ? AND w.expires_at > ?`,
        [chainName, now]
      )

      if (rows.length === 0) continue

      const adapter = getAdapter(chainName)
      const scanFn = SCAN_FUNCTIONS[chainName]
      if (!scanFn) continue

      for (const row of rows) {
        try {
          const tx = await scanFn(adapter, row.address, row.expected_amount, row.created_at, usedHashes)
          if (tx) {
            // 双保险：UPDATE 前再查一次，防止并发竞态
            const conflict = await queryOne(
              `SELECT id FROM crypto_watch_list WHERE tx_hash = ? LIMIT 1`,
              [tx.hash]
            )
            if (conflict) {
              console.warn(`[Monitor] crypto_tx_conflict: order=${row.order_id} hash=${tx.hash} already claimed by watch ${conflict.id}`)
              continue
            }

            console.log(`[Monitor] Detected ${chainName} payment: ${tx.hash} (${tx.amount} USDT) for address ${row.address}`)
            try {
              await queryRun(
                `UPDATE crypto_watch_list SET tx_hash = ?, status = 'confirming', confirmations = 0 WHERE id = ? AND status = 'pending'`,
                [tx.hash, row.id]
              )
            } catch (dupErr) {
              if (dupErr.code === 'ER_DUP_ENTRY') {
                console.warn(`[Monitor] crypto_tx_conflict (dup key): order=${row.order_id} hash=${tx.hash}`)
                continue
              }
              throw dupErr
            }
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

export async function scanTronPayment(adapter, address, expectedAmount, createdAt, excludeHashes) {
    const apiKey = await getCryptoWalletApiKey('TRON')
    const baseUrl = adapter.getApiBaseUrl()
    const createdMs = parseBeijing(createdAt)?.getTime() ?? 0
    if (!createdMs) { console.error(`[Monitor] TRON: failed to parse createdAt: ${createdAt}`); return null }
    const url = `${baseUrl}/v1/accounts/${address}/transactions/trc20?limit=200&only_confirmed=true&min_timestamp=${createdMs}&contract_address=${USDT_CONTRACTS.TRON}`
    const resp = await fetch(url, {
      headers: { 'TRON-PRO-API-KEY': apiKey, 'Accept': 'application/json' }
    })
    if (!resp.ok) return null
    const data = await resp.json()
    if (!data.data) return null

    const amountText = String(expectedAmount).trim()
    if (!/^\d+(\.\d{1,6})?$/.test(amountText)) return null
    const [whole, fraction = ''] = amountText.split('.')
    const expectedUnits = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))
    for (const tx of data.data) {
      if (excludeHashes?.has(tx.transaction_id)) continue
      if (tx.to !== address) continue
      if (tx.block_timestamp && tx.block_timestamp < createdMs) continue
      let actualUnits
      try { actualUnits = BigInt(tx.value) } catch { continue }
      if (actualUnits === expectedUnits) {
        const amount = Number(actualUnits) / 1e6
        return { hash: tx.transaction_id, amount }
      }
    }
    return null
}

const SCAN_FUNCTIONS = {
  TRON: scanTronPayment,

  ETH: async (adapter, address, expectedAmount, createdAt, excludeHashes) => {
    const apiKey = await getCryptoWalletApiKey('ETH')
    const baseUrl = adapter.getApiBaseUrl()
    const url = `${baseUrl}/api?module=account&action=tokentx&address=${address}&contractaddress=${USDT_CONTRACTS.ETH}&sort=desc&page=1&offset=20&apikey=${apiKey}`
    const resp = await fetch(url)
    if (!resp.ok) return null
    const data = await resp.json()
    if (!data.result) return null

    const createdMs = parseBeijing(createdAt)?.getTime() ?? 0
    if (!createdMs) { console.error(`[Monitor] ETH: failed to parse createdAt: ${createdAt}`); return null }
    const expected = parseFloat(expectedAmount)
    for (const tx of data.result) {
      if (excludeHashes?.has(tx.hash)) continue
      if (tx.to.toLowerCase() !== address.toLowerCase()) continue
      if (tx.timeStamp && parseInt(tx.timeStamp) * 1000 < createdMs) continue
      const amount = parseInt(tx.value) / 1e6
      if (amount === expected) {
        return { hash: tx.hash, amount }
      }
    }
    return null
  },

  BSC: async (adapter, address, expectedAmount, createdAt, excludeHashes) => {
    const apiKey = await getCryptoWalletApiKey('BSC')
    const baseUrl = adapter.getApiBaseUrl()
    const url = `${baseUrl}/api?module=account&action=tokentx&address=${address}&contractaddress=${USDT_CONTRACTS.BSC}&sort=desc&page=1&offset=20&apikey=${apiKey}`
    const resp = await fetch(url)
    if (!resp.ok) return null
    const data = await resp.json()
    if (!data.result) return null

    const createdMs = parseBeijing(createdAt)?.getTime() ?? 0
    if (!createdMs) { console.error(`[Monitor] BSC: failed to parse createdAt: ${createdAt}`); return null }
    const expected = parseFloat(expectedAmount)
    for (const tx of data.result) {
      if (excludeHashes?.has(tx.hash)) continue
      if (tx.to.toLowerCase() !== address.toLowerCase()) continue
      if (tx.timeStamp && parseInt(tx.timeStamp) * 1000 < createdMs) continue
      const amount = parseInt(tx.value) / 1e18
      if (amount === expected) {
        return { hash: tx.hash, amount }
      }
    }
    return null
  },

  SOL: async (adapter, address, expectedAmount, createdAt, excludeHashes) => {
    const rpcUrl = await adapter.getRpcUrl()
    const createdMs = parseBeijing(createdAt)?.getTime() ?? 0
    if (!createdMs) { console.error(`[Monitor] SOL: failed to parse createdAt: ${createdAt}`); return null }
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
      if (excludeHashes?.has(sig.signature)) continue
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

      const preUsdt = preTokens.find(t => t.mint === USDT_CONTRACTS.SOL && t.owner === address)
      const postUsdt = postTokens.find(t => t.mint === USDT_CONTRACTS.SOL && t.owner === address)

      const preAmount = preUsdt ? parseFloat(preUsdt.uiTokenAmount.uiAmountString || '0') : 0
      const postAmount = postUsdt ? parseFloat(postUsdt.uiTokenAmount.uiAmountString || '0') : 0
      const diff = postAmount - preAmount

      const expected = parseFloat(expectedAmount)
      if (diff > 0 && diff === expected) {
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
