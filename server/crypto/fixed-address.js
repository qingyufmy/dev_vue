import { queryAll } from '../db.js'

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

export async function generateUniqueAmount(baseAmount, orderId, plan, period, options = {}) {
  const amountStr = baseAmount.toFixed(6)
  const baseNum = parseFloat(amountStr)
  const intPart = Math.floor(baseNum)

  let whereClause = `crypto_amount IS NOT NULL AND status = 'pending' AND crypto_amount >= ? AND crypto_amount < ?`
  const params = [intPart, intPart + 1]

  if (options.chain) {
    whereClause += ' AND crypto_chain = ?'
    params.push(options.chain)
  }
  if (options.address) {
    whereClause += ' AND crypto_address = ?'
    params.push(options.address)
  }

  const sql = `SELECT crypto_amount FROM orders WHERE ${whereClause}${options.run ? ' FOR UPDATE' : ''}`
  const raw = options.run
    ? await options.run(sql, params)
    : await queryAll(sql, params)
  const rows = options.run ? (raw?.[0] || []) : raw

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


