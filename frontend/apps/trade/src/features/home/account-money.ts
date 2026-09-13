/** Display decimal text at two places, rounding ties away from zero without floating-point conversion. */
export function accountMoney(value?: string | null, currency = '') {
  if (value == null || !/^-?\d+(?:\.\d+)?$/.test(value)) return '--'
  const negative = value.startsWith('-')
  const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.')
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2))
    + (fraction.length > 2 && fraction[2]! >= '5' ? 1n : 0n)
  const integer = (cents / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative && cents !== 0n ? '-' : ''}${integer}.${(cents % 100n).toString().padStart(2, '0')} ${currency}`.trim()
}
