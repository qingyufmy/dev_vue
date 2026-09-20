import type { PositionCreationInventory } from './reference-position-lifecycle.js'
import { InferenceError } from '../domain/inference.js'
import { readReferenceOrderCreation, type ReferencePendingCreationReader, type ReferenceCreationDecision } from './reference-pending-creation.js'
import type { readReferencePositionLifecycles } from './reference-position-lifecycle.js'

export type ReferencePositionCreationReader = ReferencePendingCreationReader
export type ReferencePositionCreation =
  | { ticket: string; status: 'unresolved'; reason: 'lifecycle_unresolved' | 'order_origin_missing' | 'mixed_order_origins' }
  | { ticket: string; status: 'creation_strategy_matched'; strategyId: string; orderTickets: string[]; creationDecisions: Array<ReferenceCreationDecision & { orderTicket: string }> | null }

/** Creation attribution only. Coverage and exact history provenance must be checked before model use. */
export async function readReferencePositionCreation(input: PositionCreationInventory,
  inputLifecycles: Awaited<ReturnType<typeof readReferencePositionLifecycles>>, reader: ReferencePositionCreationReader) {
  const inventory = structuredClone(input), lifecycles = structuredClone(inputLifecycles)
  const fail = (): never => { throw new InferenceError('strategy_reference_position_creation_invalid',409) }
  if (lifecycles.status === 'unsupported_platform') return {status:'unsupported_platform' as const,items:[]}
  const positions = new Map(inventory.positions.items.map(p=>[p.ticket,p]))
  if (positions.size !== inventory.positions.items.length || lifecycles.items.length !== positions.size) return fail()
  const seen = new Set<string>(), orders = new Set<string>()
  for (const item of lifecycles.items) {
    const position = positions.get(item.ticket)
    if (!position || seen.has(item.ticket)) return fail()
    seen.add(item.ticket)
    if (item.lifecycle.status === 'matches_snapshot') {
      if (item.lifecycle.positionIdentifier !== position.positionIdentifier || item.lifecycle.side !== position.side
        || item.lifecycle.volume !== position.volume || item.lifecycle.contributingOrderTickets.length === 0) return fail()
      for (const ticket of item.lifecycle.contributingOrderTickets) orders.add(ticket)
    }
  }
  const origins = orders.size ? await readReferenceOrderCreation(inventory,[...orders],reader) : []
  const byOrder = new Map(origins.map(o=>[o.ticket,o]))
  const items: ReferencePositionCreation[] = lifecycles.items.map(item=>{
    if (item.lifecycle.status !== 'matches_snapshot') return {ticket:item.ticket,status:'unresolved',reason:'lifecycle_unresolved'}
    const orderTickets = item.lifecycle.contributingOrderTickets
    const owners = orderTickets.map(ticket=>byOrder.get(ticket))
    if (owners.some(o=>!o || o.status !== 'strategy')) return {ticket:item.ticket,status:'unresolved',reason:'order_origin_missing'}
    const strategies = new Set(owners.map(o=>o?.status === 'strategy' ? o.strategyId : null))
    if (strategies.size !== 1) return {ticket:item.ticket,status:'unresolved',reason:'mixed_order_origins'}
    const creationDecisions = owners.every(o => o?.status === 'strategy' && o.decisionOrigin)
      ? owners.map((owner, index) => {
        if (owner?.status !== 'strategy' || !owner.decisionOrigin) return fail()
        return { ...owner.decisionOrigin, orderTicket: orderTickets[index]! }
      }) : null
    return {ticket:item.ticket,status:'creation_strategy_matched',strategyId:[...strategies][0]!,orderTickets:[...orderTickets],creationDecisions}
  })
  return {status:'read' as const,items}
}
