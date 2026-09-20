import { RiskError } from '../domain/risk.js'

/** Preserve UTC wall time explicitly; MySQL DATETIME does not accept a Z suffix. */
export function riskSqlTime(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new RiskError('risk_timestamp_invalid', 422)
  return value.slice(0, 23).replace('T', ' ')
}

/** DATETIME strings carry UTC wall time, regardless of the application host zone. */
export function riskUtcTime(value: string | Date): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new RiskError('risk_timestamp_invalid', 422)
    return value.toISOString()
  }
  const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?$/.exec(value)
  const iso = match ? `${match[1]}T${match[2]}.${(match[3] ?? '').padEnd(3, '0')}Z` : value
  riskSqlTime(iso)
  return iso
}
