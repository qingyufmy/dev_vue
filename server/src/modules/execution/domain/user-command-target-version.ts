import { sha256Canonical } from './execution.js'

/** Opaque safe-integer CAS token for a resource's executable state, excluding display-only updates. */
export function userCommandTargetVersion(item: Record<string, unknown>): number {
  const { revision: _revision, currentPrice: _price, floatingProfit: _profit, ...state } = item
  return 2 ** 48 + Number.parseInt(sha256Canonical(state).slice(0, 12), 16)
}
