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

/** Sum the displayed position amounts exactly; unavailable collections stay unknown. */
export function positionProfitTotal(values: readonly string[], confirmed: boolean): string | null {
  if (!confirmed || values.some(value => !/^-?\d+(?:\.\d+)?$/.test(value))) return null
  const scale = Math.max(2, ...values.map(value => value.split('.')[1]?.length ?? 0))
  const total = values.reduce((sum, value) => {
    const negative = value.startsWith('-')
    const [whole = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.')
    return sum + BigInt(whole + fraction.padEnd(scale, '0')) * (negative ? -1n : 1n)
  }, 0n)
  const digits = (total < 0n ? -total : total).toString().padStart(scale + 1, '0')
  return `${total < 0n ? '-' : ''}${digits.slice(0, -scale)}.${digits.slice(-scale)}`
}
