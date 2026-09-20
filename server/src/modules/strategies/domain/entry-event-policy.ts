export interface EntryEventPolicy { version: 1; mode: 'required'; timeframe: string }
export function parseEntryEventPolicy(value: unknown): EntryEventPolicy | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('entry_event_policy_invalid')
  const item = value as Record<string, unknown>
  if (Object.keys(item).length !== 3 || item.version !== 1 || item.mode !== 'required'
    || typeof item.timeframe !== 'string' || !['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'].includes(String(item.timeframe))) throw Error('entry_event_policy_invalid')
  return { version: 1, mode: 'required', timeframe: String(item.timeframe) }
}
