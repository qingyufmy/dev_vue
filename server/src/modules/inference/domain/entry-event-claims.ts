import { parseEntryEventPolicy } from '../../strategies/index.js'
import { InferenceError } from './inference-error.js'

export interface EntryEventClaim { actionId: string; eventId: string; timeframe: string; symbol: string; side: 'buy' | 'sell'; confirmedAt: string }
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Model-selected identity must already exist in the exact frozen objective catalogue. */
export function resolveEntryEventClaims(result: { actions: readonly { actionId: string; kind: string; parameters: Record<string, unknown> }[] },
  snapshot: { entryEventPolicy?: unknown; marketEntryEvents?: unknown; analysis: { id: string }; capturedAt: string }): EntryEventClaim[] {
  let policy
  try { policy = parseEntryEventPolicy(snapshot.entryEventPolicy) } catch { throw new InferenceError('entry_event_policy_invalid', 422) }
  const claims: EntryEventClaim[] = [], ids = new Set<string>()
  for (const action of result.actions) {
    const id = action.parameters.entry_event_id, has = Object.hasOwn(action.parameters, 'entry_event_id')
    const opening = action.kind === 'market_order' || action.kind === 'pending_order'
    if (!opening && has) throw new InferenceError('entry_event_action_invalid', 422)
    if (!opening || (!has && !policy)) continue
    if (typeof id !== 'string' || !/^event:[0-9a-f]{64}$/.test(id)) throw new InferenceError('entry_event_required', 422)
    if (ids.has(id)) throw new InferenceError('entry_event_duplicate_action', 422)
    ids.add(id)
    if (!/^[A-Za-z0-9_-]{1,191}$/.test(action.actionId)) throw new InferenceError('entry_event_action_invalid', 422)
    const catalogue = snapshot.marketEntryEvents
    if (!object(catalogue) || catalogue.analysisId !== snapshot.analysis.id || !object(catalogue.timeframes)) throw new InferenceError('entry_event_evidence_missing', 422)
    const matches: EntryEventClaim[] = []
    for (const [timeframe, raw] of Object.entries(catalogue.timeframes)) {
      if (!object(raw) || raw.state !== 'ready' || !Array.isArray(raw.events) || raw.timeframe !== timeframe
        || raw.sourceAccountId !== catalogue.sourceAccountId || raw.symbol !== action.parameters.symbol) continue
      for (const event of raw.events) {
        if (!object(event) || event.id !== id) continue
        const side = event.direction === 'up' ? 'buy' : event.direction === 'down' ? 'sell' : null
        const actionSide = action.kind === 'pending_order' && typeof action.parameters.type === 'string'
          ? action.parameters.type.startsWith('buy_') ? 'buy' : action.parameters.type.startsWith('sell_') ? 'sell' : null
          : action.parameters.side
        if (!side || side !== actionSide || event.stillValid !== true || (policy && timeframe !== policy.timeframe)
          || typeof event.confirmedAt !== 'string' || !Number.isFinite(Date.parse(event.confirmedAt))
          || Date.parse(event.confirmedAt) > Date.parse(snapshot.capturedAt)) throw new InferenceError('entry_event_not_admissible', 422)
        matches.push({ actionId: action.actionId, eventId: id, timeframe, symbol: String(raw.symbol), side, confirmedAt: event.confirmedAt })
      }
    }
    if (matches.length !== 1) throw new InferenceError('entry_event_evidence_missing', 422)
    claims.push(matches[0]!)
  }
  return claims
}
