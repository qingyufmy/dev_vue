import { sha256Canonical } from '../../../shared/canonical-json.js'
import { MarketReadError } from './calendar.js'

type Direction = 'supportive' | 'adverse' | 'neutral' | 'uncertain'
type Freshness = 'fresh' | 'stale' | 'missing' | 'disabled' | 'invalid'
export interface MacroFactor {
  code: string; label: string; value: string | null; unit: string | null
  observation_at: string; available_at: string; freshness: Freshness; gold_relation: Direction
}
export interface MacroSnapshotRecord {
  id: string; schemaVersion: number; revision: string; businessDate: string; horizon: string
  dataCutoffAt: string; publishedAt: string; validUntil: string
  status: 'fresh' | 'stale' | 'partial' | 'unavailable'
  contentSha256: string; payload: unknown
}

function invalid(): never { throw new MarketReadError('macro_snapshot_data_invalid', 503) }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) return invalid()
  return value
}
function utc(value: unknown): string {
  const result = text(value, 24)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(result)
    || !Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) return invalid()
  return result
}
function member<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== 'string' || !choices.includes(value as T)) return invalid()
  return value as T
}

/** V1 storage payload.display is the only browser projection. Never fall back to analysis_evidence. */
export function publicMacroSnapshot(record: MacroSnapshotRecord, now: string) {
  let payload: Record<string, unknown>
  try {
    payload = object(typeof record.payload === 'string' ? JSON.parse(record.payload) : record.payload)
    if (!/^[a-f0-9]{64}$/.test(record.contentSha256) || sha256Canonical(payload) !== record.contentSha256) return invalid()
  } catch { return invalid() }
  if (record.schemaVersion !== 1 || record.horizon !== 'medium_term' || !/^(0|[1-9]\d*)$/.test(record.revision)) return invalid()
  const cutoff = utc(record.dataCutoffAt), published = utc(record.publishedAt), validUntil = utc(record.validUntil)
  utc(now)
  if (cutoff > published || published >= validUntil || published > now) return invalid()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(record.businessDate)) return invalid()
  utc(`${record.businessDate}T00:00:00.000Z`)
  const display = object(payload.display)
  // No frozen composite-direction rule exists yet. Do not publish an unverified direction.
  if (display.direction !== 'uncertain') return invalid()
  if (!Array.isArray(display.factors) || display.factors.length > 128) return invalid()
  const codes = new Set<string>()
  const factors: MacroFactor[] = display.factors.map(value => {
    const factor = object(value), code = text(factor.code, 64)
    if (codes.has(code)) return invalid()
    codes.add(code)
    const observation = utc(factor.observation_at), available = utc(factor.available_at)
    if (observation > cutoff || available > cutoff) return invalid()
    const decimal = factor.value === null ? null : text(factor.value, 128)
    if (decimal !== null && !/^-?\d+(?:\.\d+)?$/.test(decimal)) return invalid()
    return { code, label: text(factor.label, 191), value: decimal, unit: factor.unit === null ? null : text(factor.unit, 64),
      observation_at: observation, available_at: available,
      freshness: member(factor.freshness, ['fresh', 'stale', 'missing', 'disabled', 'invalid']),
      gold_relation: member(factor.gold_relation, ['supportive', 'adverse', 'neutral', 'uncertain']) }
  })
  const status = member(record.status, ['fresh', 'stale', 'partial', 'unavailable'])
  return { id: text(record.id, 191), schema_version: 1, revision: record.revision, business_date: record.businessDate,
    horizon: 'medium_term' as const, data_cutoff_at: cutoff, published_at: published, valid_until: validUntil,
    status: validUntil <= now && status !== 'unavailable' ? 'stale' as const : status,
    direction: 'uncertain' as const, summary: text(display.summary, 5000), factors, content_sha256: record.contentSha256 }
}

export type PublicMacroSnapshot = ReturnType<typeof publicMacroSnapshot>
export function macroSnapshotSummary(snapshot: PublicMacroSnapshot) {
  const { factors, ...summary } = snapshot
  return { ...summary, factor_count: factors.length }
}
