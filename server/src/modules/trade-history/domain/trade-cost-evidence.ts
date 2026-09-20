import { canonicalEvidence } from './terminal-history-projection.js'
import { TradeHistoryError } from './trade-history.js'

const fields = ['profit', 'commission', 'swap', 'fee'] as const
export type TradeCostField = typeof fields[number]
export type TradeCostEvidence = { complete: boolean; fields: Record<TradeCostField,
  { status: 'explicit'; value: string } | { status: 'missing' | 'invalid' }> }

/** Field presence is independent of settlement completeness or future broker corrections. */
export function readTradeCostEvidence(rawJson: string, expectedHash: string): TradeCostEvidence {
  let value: unknown
  try { value = JSON.parse(rawJson) } catch { throw new TradeHistoryError('trade_cost_evidence_invalid', 409) }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || canonicalEvidence(value as Record<string, unknown>).hash !== expectedHash) {
    throw new TradeHistoryError('trade_cost_evidence_invalid', 409)
  }
  const record = value as Record<string, unknown>
  const result = Object.fromEntries(fields.map(field => {
    const item = record[field]
    if (!Object.hasOwn(record, field) || item === null || item === '') return [field, { status: 'missing' }]
    const text = typeof item === 'string' ? item : typeof item === 'number' && Number.isFinite(item) ? String(item) : ''
    if (!/^-?(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$/.test(text)) return [field, { status: 'invalid' }]
    return [field, { status: 'explicit', value: text }]
  })) as TradeCostEvidence['fields']
  return { complete: fields.every(field => result[field].status === 'explicit'), fields: result }
}
