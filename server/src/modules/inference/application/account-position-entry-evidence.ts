import type { AccountLiveRoute, ExecutionPositionCollection, OpenPosition } from '../../trading/index.js'
import { contentHash, InferenceError, type JsonObject } from '../domain/inference.js'
import { readReferencePositionLifecycles } from './reference-position-lifecycle.js'
import { readReferencePositionCreation, type ReferencePositionCreationReader } from './reference-position-creation.js'
import { readReferencePositionEntryAnalyses } from './reference-position-entry-analyses.js'
import { projectReferenceEntryEvidence, freezeReferenceEntryEvidence, type ReferenceEntryEvidence } from './reference-entry-evidence.js'
import type { ReferencePositionHistoryEvidence } from './reference-position-evidence.js'
import type { ReferencePositionLifecycleReader } from './reference-position-lifecycle.js'
import type { TradeDecisionEntryAnalysisReader } from './trade-decision-entry-analysis-reader.js'

export interface AccountPositionEntryScope {
  userId: number; accountId: string; positionsRevision: number; asOf: string; positions: OpenPosition[]
}
export interface AccountPositionEntries {
  scopeHash: string
  items: Array<{ ticket: string; entryEvidence: ReferenceEntryEvidence }>
}
export interface AccountPositionEntryReader {
  read(scope: AccountPositionEntryScope): Promise<AccountPositionEntries>
}

export function unavailableAccountPositionEntries(scope: AccountPositionEntryScope): AccountPositionEntries {
  return { scopeHash: contentHash(scope), items: scope.positions.map(position => ({ ticket: position.ticket,
    entryEvidence: { schemaVersion: 1, state: 'unavailable', reason: 'not_collected' } })) }
}

/** Current owner inventory only. Every contributing order must have an exact creation decision. */
export async function readAccountPositionEntries(input: AccountPositionEntryScope, inputRoute: AccountLiveRoute,
  inputCollection: ExecutionPositionCollection | null, ports: {
    history: { read(scope: Parameters<ReferencePositionLifecycleReader['read']>[0]): Promise<ReferencePositionHistoryEvidence> }
    origins: ReferencePositionCreationReader; analyses: TradeDecisionEntryAnalysisReader
  }): Promise<AccountPositionEntries> {
  const scope = structuredClone(input), route = structuredClone(inputRoute), collection = structuredClone(inputCollection)
  if (!collection || route.userId !== scope.userId || route.accountId !== scope.accountId || route.platform !== 'mt5'
    || collection.accountId !== scope.accountId || collection.revision !== scope.positionsRevision) return unavailableAccountPositionEntries(scope)
  const observed = Date.parse(collection.observedAt), asOf = Date.parse(scope.asOf)
  if (!Number.isFinite(observed) || !Number.isFinite(asOf) || observed > asOf || asOf - observed > 30_000
    || collection.positions.length !== scope.positions.length || scope.positions.length > 1000) return unavailableAccountPositionEntries(scope)
  const current = new Map(collection.positions.map(position => [position.ticket, position]))
  if (current.size !== scope.positions.length || new Set(scope.positions.map(position => position.ticket)).size !== current.size) {
    throw new InferenceError('account_position_entry_evidence_invalid', 409)
  }
  for (const position of scope.positions) {
    const found = current.get(position.ticket)
    if (!found || position.accountId !== scope.accountId || position.revision !== scope.positionsRevision
      || found.positionIdentifier !== (position.positionIdentifier ?? null)
      || ['accountId', 'symbol', 'side', 'volume', 'stopLoss', 'takeProfit'].some(key =>
        found[key as keyof typeof found] !== position[key as keyof OpenPosition])) return unavailableAccountPositionEntries(scope)
  }
  const inventory = { route, authorization: { operatorUserId: scope.userId },
    positions: { revision: scope.positionsRevision, observedAt: collection.observedAt, items: scope.positions } }
  const lifecycles = await readReferencePositionLifecycles(inventory, { async read(position) {
    const evidence = await ports.history.read(position)
    return evidence.status === 'source_matched' ? evidence.lifecycle : { status: 'unresolved', reason: 'snapshot_mismatch' }
  } })
  const origins = await readReferencePositionCreation(inventory, lifecycles, ports.origins)
  const analyses = await readReferencePositionEntryAnalyses(inventory, origins, ports.analyses)
  return { scopeHash: contentHash(scope), items: scope.positions.map(position => {
    const origin = origins.items.find(item => item.ticket === position.ticket)
    return { ticket: position.ticket, entryEvidence: projectReferenceEntryEvidence({
      referenceId: `account:${scope.accountId}:position:${position.positionIdentifier ?? position.ticket}`,
      userId: scope.userId, accountId: scope.accountId, symbol: position.symbol, asOf: scope.asOf,
      strategyId: origin?.status === 'creation_strategy_matched' ? origin.strategyId : '',
      creationDecisions: origin?.status === 'creation_strategy_matched' ? origin.creationDecisions : null,
      evidence: analyses.find(item => item.ticket === position.ticket),
    }) }
  }) }
}

/** Validate exact scope and ticket coverage at the durable model-input boundary. */
export async function freezeAccountPositionEntries(input: AccountPositionEntryScope, reader?: AccountPositionEntryReader): Promise<JsonObject> {
  const scope = structuredClone(input)
  const value = structuredClone(reader ? await reader.read(structuredClone(scope)) : unavailableAccountPositionEntries(scope))
  const fail = (): never => { throw new InferenceError('account_position_entry_evidence_invalid', 409) }
  if (value.scopeHash !== contentHash(scope) || !Array.isArray(value.items) || value.items.length !== scope.positions.length
    || new Set(value.items.map(item => item.ticket)).size !== scope.positions.length
    || value.items.some(item => !scope.positions.some(position => position.ticket === item.ticket))) return fail()
  const items = value.items.map(item => ({ ticket: item.ticket, entryEvidence: freezeReferenceEntryEvidence(item.entryEvidence) }))
  if (Buffer.byteLength(JSON.stringify(items)) > 256 * 1024) return fail()
  return { schemaVersion: 1, purpose: 'account_position_creation_analysis_only', accountId: scope.accountId,
    positionsRevision: scope.positionsRevision, scopeHash: value.scopeHash, items }
}
