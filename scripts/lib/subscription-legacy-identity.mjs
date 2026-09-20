import { hash } from './v4-backfill-contract.mjs'

// One legacy subscription may expand into several symbols. Keep its original
// integer PK in the map and distinguish symbols in the bounded entity kind.
export function subscriptionLegacyIdentity(sourceId, symbol) {
  if (typeof sourceId !== 'string' || !/^[1-9]\d{0,19}$/.test(sourceId) || BigInt(sourceId) > 18446744073709551615n
    || typeof symbol !== 'string' || !/^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(symbol)) throw Error('subscription_legacy_identity_invalid')
  return { sourceTable: 'strategy_subscriptions', sourcePk: [{ type: 'integer', value: sourceId }],
    legacyId: `${sourceId}:${symbol}`, entityKind: `subscription-${hash(symbol).slice(0, 48)}` }
}
