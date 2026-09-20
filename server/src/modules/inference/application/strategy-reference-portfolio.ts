import { freezeReferenceEntryEvidence, type ReferenceEntryEvidence } from './reference-entry-evidence.js'
import { contentHash, InferenceError, type JsonObject } from '../domain/inference.js'

export interface StrategyReferenceScope {
  analysisId: string
  userId: number; targetAccountId: string; analysisStrategyId: string; traderStrategyId: string; symbol: string; asOf: string
}
export interface StrategyReferenceItem {
  entryEvidence?: ReferenceEntryEvidence
  referenceId: string; side: 'buy' | 'sell'; volume: string; entryPrice: string; stopLoss: string | null; takeProfit: string | null
}
export interface StrategyReferencePendingItem extends StrategyReferenceItem {
  orderType: 'buy_limit' | 'sell_limit' | 'buy_stop' | 'sell_stop' | 'buy_stop_limit' | 'sell_stop_limit'
  validUntil: string | null
}
export type StrategyReferencePortfolio =
  | { state: 'not_applicable'; scope: StrategyReferenceScope }
  | { state: 'ready'; scope: StrategyReferenceScope; sourceAccountId: string; observedAt: string;
      positionsRevision: number; pendingOrdersRevision: number; positions: StrategyReferenceItem[]; pendingOrders: StrategyReferencePendingItem[] }

/** Provider owns authorization, observer selection and exact strategy attribution. */
export interface StrategyReferencePortfolioReader {
  read(scope: StrategyReferenceScope): Promise<StrategyReferencePortfolio>
}

export async function freezeStrategyReferencePortfolio(scope: StrategyReferenceScope, reader?: StrategyReferencePortfolioReader): Promise<JsonObject | undefined> {
  if (!reader) return undefined
  const expected = structuredClone(scope)
  const fail = (): never => { throw new InferenceError('strategy_reference_portfolio_invalid', 409) }
  const identifier = (value: unknown) => typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n
  const utc = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
  if (!Number.isSafeInteger(expected.userId) || expected.userId < 1
    || typeof expected.analysisId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(expected.analysisId)
    || ![expected.targetAccountId, expected.analysisStrategyId, expected.traderStrategyId].every(identifier)
    || typeof expected.symbol !== 'string' || !/^[A-Z0-9._-]{1,64}$/.test(expected.symbol) || !utc(expected.asOf)) return fail()
  const value = structuredClone(await reader.read(structuredClone(expected)))
  if (!value || !value.scope || contentHash(value.scope) !== contentHash(expected)) return fail()
  if (value.state === 'not_applicable') return { schemaVersion: 2, state: 'not_applicable', analysisId: expected.analysisId }
  if (value.state !== 'ready' || !identifier(value.sourceAccountId)
    || ![value.positionsRevision, value.pendingOrdersRevision].every(revision => Number.isSafeInteger(revision) && revision > 0)) return fail()
  const observed = Date.parse(value.observedAt), asOf = Date.parse(expected.asOf)
  if (!Number.isFinite(observed) || !Number.isFinite(asOf) || new Date(observed).toISOString() !== value.observedAt
    || asOf < observed || asOf - observed > 30_000) return fail()
  const positive = (item: unknown) => typeof item === 'string' && /^(?:0|[1-9]\d{0,29})(?:\.\d{1,18})?$/.test(item) && Number(item) > 0
  const collection = (items: StrategyReferenceItem[], pending = false): JsonObject[] => {
    if (!Array.isArray(items) || items.length > 1000) return fail()
    const ids = new Set<string>()
    return items.map(item => {
      if (!item || typeof item.referenceId !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,31}:[A-Za-z0-9_.:-]{1,158}$/.test(item.referenceId) || ids.has(item.referenceId)
        || !['buy', 'sell'].includes(item.side) || !positive(item.volume) || !positive(item.entryPrice)
        || ![item.stopLoss, item.takeProfit].every(price => price === null || positive(price))) return fail()
      ids.add(item.referenceId)
      const order = item as StrategyReferencePendingItem
      if (pending && (!['buy_limit', 'sell_limit', 'buy_stop', 'sell_stop', 'buy_stop_limit', 'sell_stop_limit'].includes(order.orderType)
        || !order.orderType.startsWith(item.side) || (order.validUntil !== null && !utc(order.validUntil)))) return fail()
      // Reference IDs deliberately have no terminal-ticket meaning.
      return { referenceId: item.referenceId, side: item.side, volume: item.volume, entryPrice: item.entryPrice,
        stopLoss: item.stopLoss, takeProfit: item.takeProfit,
        ...(!pending && item.entryEvidence ? { entryEvidence: freezeReferenceEntryEvidence(item.entryEvidence) } : {}), ...(pending ? { orderType: order.orderType, validUntil: order.validUntil } : {}) }
    })
  }
  const frozen: JsonObject = { schemaVersion: 2, state: 'ready', purpose: 'strategy_reference_only', analysisId: expected.analysisId,
    analysisStrategyId: expected.analysisStrategyId, traderStrategyId: expected.traderStrategyId, symbol: expected.symbol,
    sourceAccountId: value.sourceAccountId, observedAt: value.observedAt, positionsRevision: value.positionsRevision,
    pendingOrdersRevision: value.pendingOrdersRevision, positions: collection(value.positions), pendingOrders: collection(value.pendingOrders, true) }
  const entryBytes = (frozen.positions as JsonObject[]).reduce((total, item) => total + (item.entryEvidence ? Buffer.byteLength(JSON.stringify(item.entryEvidence)) : 0), 0)
  if (entryBytes > 256 * 1024) throw new InferenceError('strategy_reference_entry_capacity_exceeded', 409)
  return { ...frozen, evidenceHash: contentHash(frozen) }
}
