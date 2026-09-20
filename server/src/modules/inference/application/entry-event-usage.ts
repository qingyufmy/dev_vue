import { InferenceError, type JsonObject } from '../domain/inference.js'
export interface EntryEventUsageReader {
  read(scope: { userId: number; accountId: string; strategyId: string; eventIds: string[] }): Promise<{ coverageStartUtc: string; items: Array<{ eventId: string; state: 'reserved' | 'consumed' }> }>
}
export async function freezeEntryEventUsage(scope: { userId: number; accountId: string; strategyId: string },
  timeframes: JsonObject | undefined, reader?: EntryEventUsageReader): Promise<JsonObject | undefined> {
  if (!timeframes) return undefined
  const ids = new Set<string>(), times = new Map<string, number>()
  for (const raw of Object.values(timeframes)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.events)) continue
    for (const event of raw.events) {
      if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.id !== 'string' || !/^event:[a-f0-9]{64}$/.test(event.id)) {
        throw new InferenceError('entry_event_usage_invalid', 409)
      }
      ids.add(event.id)
      times.set(event.id, typeof event.confirmedAt === 'string' ? Date.parse(event.confirmedAt) : NaN)
    }
  }
  if (ids.size > 28) throw new InferenceError('entry_event_usage_invalid', 409)
  if (!reader) return { schemaVersion: 1, state: 'unavailable' }
  const evidence = structuredClone(await reader.read({ ...scope, eventIds: [...ids] })), rows = evidence.items
  const coverage = Date.parse(evidence.coverageStartUtc)
  if (!Number.isFinite(coverage)) throw new InferenceError('entry_event_usage_invalid', 409)
  if (new Set(rows.map(row => row.eventId)).size !== rows.length || rows.some(row => !ids.has(row.eventId) || !['reserved', 'consumed'].includes(row.state))) {
    throw new InferenceError('entry_event_usage_invalid', 409)
  }
  return { schemaVersion: 1, state: 'read', coverageStartUtc: evidence.coverageStartUtc, accountId: scope.accountId, strategyId: scope.strategyId,
    items: [...ids].sort().map(eventId => ({ eventId, state: rows.find(row => row.eventId === eventId)?.state ?? (Number.isFinite(times.get(eventId)) && times.get(eventId)! > coverage ? 'available' : 'unknown') })) }
}
