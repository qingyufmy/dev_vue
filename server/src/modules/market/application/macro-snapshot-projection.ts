import { publicMacroSnapshot } from '../domain/macro-snapshot.js'
import { MarketReadError } from '../domain/calendar.js'
import type { ReadableMacroSnapshot } from './macro-snapshot-reader.js'

function decimal(value: string | null) {
  if (value === null) return null
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value)) throw new MarketReadError('macro_snapshot_lineage_invalid', 503)
  let [integer, fraction = ''] = value.replace(/^-/, '').split('.') as [string, string?]
  integer = integer.replace(/^0+(?=\d)/, '')
  fraction = fraction.replace(/0+$/, '')
  return `${value.startsWith('-') && (integer !== '0' || fraction) ? '-' : ''}${integer}${fraction ? '.' + fraction : ''}`
}

export function projectReadableMacroSnapshot(input: ReadableMacroSnapshot, now: string) {
  const snapshot = publicMacroSnapshot(input.record, now)
  if (input.observations.length === 0) throw new MarketReadError('macro_snapshot_lineage_invalid', 503)
  for (const observation of input.observations) {
    if ([observation.observationAt, observation.availableAt, observation.ingestedAt].some(value =>
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value || value > snapshot.data_cutoff_at)) {
      throw new MarketReadError('macro_snapshot_lineage_invalid', 503)
    }
  }
  for (const factor of snapshot.factors) {
    if (!input.observations.some(observation => observation.factorCode === factor.code
      && observation.observationAt === factor.observation_at && observation.availableAt === factor.available_at
      && decimal(observation.value) === decimal(factor.value))) throw new MarketReadError('macro_snapshot_lineage_invalid', 503)
  }
  return snapshot
}
