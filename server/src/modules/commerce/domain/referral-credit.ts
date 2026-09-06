const scale = 100000000n
const maximum = 10n ** 20n - 1n

function units(value: unknown): bigint {
  if (typeof value !== 'string' || value.length > 22 || !/^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/.test(value)) {
    throw new Error('referral_credit_invalid')
  }
  const negative = value.startsWith('-')
  const [whole = '0', fraction = ''] = value.replace(/^-/, '').split('.')
  const result = BigInt(whole) * scale + BigInt(fraction.padEnd(8, '0'))
  if (result > maximum) throw new Error('referral_credit_overflow')
  return negative ? -result : result
}

function decimal(value: bigint): string {
  if (value > maximum || value < -maximum) throw new Error('referral_credit_overflow')
  const magnitude = value < 0n ? -value : value
  return `${value < 0n ? '-' : ''}${magnitude / scale}.${String(magnitude % scale).padStart(8, '0')}`
}

export interface ReferralCreditQuote {
  balance: string
  orderAmount: string
  appliedCredit: string
  payableAmount: string
  remainingBalance: string
}

// Quotes do not reserve money. The application must recalculate under its balance lock.
export function quoteReferralCredit(balance: unknown, orderAmount: unknown, requested: boolean): ReferralCreditQuote {
  const available = units(balance), price = units(orderAmount)
  if (typeof requested !== 'boolean' || price < 0n) throw new Error('referral_credit_quote_invalid')
  const positiveBalance = available > 0n ? available : 0n
  const applied = requested ? (positiveBalance < price ? positiveBalance : price) : 0n
  return { balance: decimal(available), orderAmount: decimal(price), appliedCredit: decimal(applied),
    payableAmount: decimal(price - applied), remainingBalance: decimal(available - applied) }
}

export interface ReferralBalanceChange {
  previousBalance: string
  delta: string
  nextBalance: string
}

// Arithmetic only: the transaction must establish entitlement, event uniqueness and revision.
// A preserved negative opening balance is not silently replaced by zero.
export function projectReferralBalance(balance: unknown, amount: unknown, direction: 'credit' | 'debit'): ReferralBalanceChange {
  const previous = units(balance), magnitude = units(amount)
  if (magnitude <= 0n || !['credit', 'debit'].includes(direction)) throw new Error('referral_credit_change_invalid')
  const delta = direction === 'credit' ? magnitude : -magnitude
  if (direction === 'debit' && previous < magnitude) throw new Error('referral_credit_insufficient')
  return { previousBalance: decimal(previous), delta: decimal(delta), nextBalance: decimal(previous + delta) }
}
