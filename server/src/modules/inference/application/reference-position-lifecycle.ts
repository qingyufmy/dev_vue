import type { StrategyObserverInventory } from '../../trading/index.js'
import { InferenceError } from '../domain/inference.js'

export type PositionCreationInventory = Pick<StrategyObserverInventory, 'route' | 'positions'> & {
  authorization: Pick<StrategyObserverInventory['authorization'], 'operatorUserId'>
}

// Consumer-owned evidence port avoids a dependency cycle through trade-history and Bridge.
export interface ReferencePositionLifecycleReader {
  read(scope: { accountId: string; positionIdentifier: string | null; symbol: string;
    side: 'buy' | 'sell'; volume: string; observedAtUtcMsc: number }): Promise<
      | { status: 'unresolved'; reason: string }
      | { status: 'matches_snapshot'; positionIdentifier: string; side: 'buy' | 'sell'; volume: string;
          contributingOrderTickets: string[]; dealTickets: string[] }>
}

/** Internal quantity evidence only; neither coverage nor strategy attribution. */
export async function readReferencePositionLifecycles(input: PositionCreationInventory, reader: ReferencePositionLifecycleReader) {
  const inventory = structuredClone(input)
  const fail = (): never => { throw new InferenceError('strategy_reference_position_lifecycle_invalid', 409) }
  if (inventory.route.platform !== 'mt5') return { status: 'unsupported_platform' as const, items: [] }
  const observedAtUtcMsc = Date.parse(inventory.positions.observedAt)
  const id = (value: unknown): value is string => typeof value === 'string'
    && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n
  if (!Number.isSafeInteger(observedAtUtcMsc) || observedAtUtcMsc <= 0
    || new Date(observedAtUtcMsc).toISOString() !== inventory.positions.observedAt
    || inventory.positions.items.length > 1000) return fail()
  const tickets = new Set<string>(), identifiers = new Set<string>()
  // Validate the entire collection before any history access.
  for (const position of inventory.positions.items) {
    const identifier = position.positionIdentifier ?? null
    if (!id(position.ticket) || tickets.has(position.ticket) || position.accountId !== inventory.route.accountId
      || position.revision !== inventory.positions.revision
      || (identifier !== null && (!id(identifier) || identifiers.has(identifier)))) return fail()
    tickets.add(position.ticket)
    if (identifier !== null) identifiers.add(identifier)
  }
  const items = []
  for (const position of inventory.positions.items) {
    const lifecycle = structuredClone(await reader.read({ accountId: inventory.route.accountId,
      positionIdentifier: position.positionIdentifier ?? null, symbol: position.symbol,
      side: position.side, volume: position.volume, observedAtUtcMsc }))
    if (!lifecycle) return fail()
    if (lifecycle.status === 'matches_snapshot') {
      if (lifecycle.positionIdentifier !== position.positionIdentifier
        || lifecycle.side !== position.side || lifecycle.volume !== position.volume) return fail()
      for (const ids of [lifecycle.contributingOrderTickets, lifecycle.dealTickets]) {
        if (!Array.isArray(ids) || ids.length === 0 || ids.length > 10000
          || !ids.every(id) || new Set(ids).size !== ids.length) return fail()
      }
    } else if (lifecycle.status !== 'unresolved'
      || !['identifier_missing', 'facts_invalid', 'lifecycle_invalid', 'snapshot_mismatch'].includes(lifecycle.reason)) return fail()
    items.push({ ticket: position.ticket, lifecycle })
  }
  return { status: 'read' as const, items }
}
