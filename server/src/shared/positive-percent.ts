/** Canonical positive decimal percentage, at most 18 fraction digits and <= 100. */
export function positivePercent(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,2})(?:\.\d{1,18})?$/.test(value)) throw new Error('positive_percent_invalid')
  const [whole, fraction = ''] = value.split('.')
  const amount = BigInt(whole!) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'))
  if (amount <= 0n || amount > 100n * 10n ** 18n) throw new Error('positive_percent_invalid')
  return value
}
