import { queryOne, queryRun, queryAll } from '../db.js'

let _fixedAddressCache = null

export async function getFixedAddress() {
  if (_fixedAddressCache) return _fixedAddressCache

  const rows = await queryAll(
    "SELECT `key`, `value` FROM system_config WHERE category = 'crypto_wallet' AND `key` IN ('fixed_tron_address', 'fixed_erc20_address', 'fixed_bep20_address', 'fixed_sol_address')"
  )

  const config = {}
  for (const row of rows) {
    config[row.key] = row.value
  }

  _fixedAddressCache = config
  return config
}

export function resetFixedAddressCache() {
  _fixedAddressCache = null
}

export async function getFixedAddressForChain(chain) {
  const config = await getFixedAddress()
  const map = {
    TRON: config.fixed_tron_address,
    ETH: config.fixed_erc20_address,
    BSC: config.fixed_bep20_address,
    SOL: config.fixed_sol_address,
  }
  return map[chain] || null
}

export async function generateUniqueAmount(baseAmount, orderId) {
  const amountStr = baseAmount.toFixed(6)
  const baseNum = parseFloat(amountStr)
  const intPart = Math.floor(baseNum)

  const rows = await queryAll(
    `SELECT crypto_amount FROM orders WHERE crypto_amount IS NOT NULL AND status = 'pending' AND crypto_amount >= ? AND crypto_amount < ?`,
    [intPart, intPart + 1]
  )

  const usedDecimals = new Set()
  for (const row of rows) {
    const val = parseFloat(row.crypto_amount)
    const decimal = Math.round((val - intPart) * 1000000)
    if (decimal > 0 && decimal < 1000000) {
      usedDecimals.add(decimal)
    }
  }

  let suffix = 1
  while (usedDecimals.has(suffix) && suffix < 1000000) {
    suffix++
  }

  if (suffix >= 1000000) {
    throw new Error('可用金额已用尽，请稍后重试')
  }

  return parseFloat((intPart + suffix / 1000000).toFixed(6))
}

export async function findOrderByAmount(chain, receivedAmount) {
  const rows = await queryAll(
    `SELECT order_id, user_id, plan, period, crypto_amount
     FROM orders
     WHERE status = 'pending' AND crypto_chain = ?
       AND ABS(crypto_amount - ?) < 0.000001
       AND crypto_expires_at > NOW()
     ORDER BY created_at DESC LIMIT 1`,
    [chain, receivedAmount]
  )

  return rows.length > 0 ? rows[0] : null
}
