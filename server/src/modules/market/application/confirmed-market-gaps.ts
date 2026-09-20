export interface ConfirmedMarketGap { from: string; to: string }
/** Only exact adjacent endpoints covered by a successful terminal comparison are accepted. */
export function unresolvedMarketGap(times: number[], step: number, confirmed: readonly ConfirmedMarketGap[] = []) {
  const accepted = new Set(confirmed.map(g => `${Date.parse(g.from)}:${Date.parse(g.to)}`))
  return times.some((time, i) => i > 0 && (time <= times[i - 1]! || time - times[i - 1]! !== step && !accepted.has(`${times[i - 1]}:${time}`)))
}
