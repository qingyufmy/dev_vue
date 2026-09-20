import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { PositionProtectionSummaryReader } from '../application/position-protection-summary-reader.js'
import type { AccountRiskSummary } from '../domain/risk.js'
import { RiskError } from '../domain/risk.js'

interface SummaryRow extends RowDataPacket { payload_json: unknown; revision: number | string; state_revision: number | string; observed_at: string; state_observed_at: string }
const iso = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const decimal = (value: unknown) => typeof value === 'string' && /^-?(0|[1-9][0-9]{0,28})(\.[0-9]{1,18})?$/.test(value)
const fail = (): never => { throw new RiskError('position_protection_summary_invalid',409) }

/** Strict canonical V4 facts; legacy aliases/default coercion must never create an apparently complete summary. */
export function createMysqlPositionProtectionSummaryReader(connection: Pick<PoolConnection, 'execute'>): PositionProtectionSummaryReader {
  return { async read(userId, accountId) {
    if (!Number.isSafeInteger(userId) || userId < 1 || userId > 2147483647 || typeof accountId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(accountId)
      || BigInt(accountId) > 18446744073709551615n) throw new RiskError('position_protection_scope_invalid',422)
    const [rows] = await connection.execute<SummaryRow[]>(`SELECT s.payload_json,s.revision,r.revision state_revision,
      DATE_FORMAT(s.observed_at_utc,'%Y-%m-%dT%H:%i:%s.%fZ') observed_at,
      DATE_FORMAT(r.observed_at_utc,'%Y-%m-%dT%H:%i:%s.%fZ') state_observed_at
      FROM account_risk_states r
      INNER JOIN account_risk_summaries s ON s.trading_account_id=r.trading_account_id
      INNER JOIN trading_accounts a ON a.id=r.trading_account_id AND a.deleted_at_utc IS NULL
      INNER JOIN trading_account_ownerships o ON o.trading_account_id=a.id AND o.user_id=r.user_id
        AND o.revision=a.ownership_revision AND o.role='owner' AND o.revoked_at_utc IS NULL
      WHERE r.trading_account_id=? AND r.user_id=? LIMIT 2 FOR SHARE`, [accountId,userId])
    if (!rows.length) return null
    if (rows.length !== 1) return fail()
    const row = rows[0]!, revision = Number(row.revision)
    if (!Number.isSafeInteger(revision) || revision < 1 || Number(row.state_revision) !== revision
      || typeof row.observed_at !== 'string' || !/\.\d{3}000Z$/.test(row.observed_at)
      || row.state_observed_at !== row.observed_at) return fail()
    const observedAt = row.observed_at.replace(/(\.\d{3})000Z$/, '$1Z')
    if (!iso(observedAt)) return fail()
    let value: unknown = row.payload_json
    try { if (typeof value === 'string') value = JSON.parse(value) }
    catch { return fail() }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
    const v = value as Record<string, unknown>
    if (v.accountId !== accountId || v.userId !== userId || v.revision !== revision || v.observedAt !== observedAt
      || typeof v.dataComplete !== 'boolean' || !Array.isArray(v.incompleteReasons) || v.incompleteReasons.some(reason => typeof reason !== 'string')
      || (v.businessDate !== null && (typeof v.businessDate !== 'string' || !iso(v.businessDate+'T00:00:00.000Z')))
      || typeof v.clockStatus !== 'string' || !['calibrated','observer_bootstrap','stale','unavailable'].includes(String(v.clockStatus))
      || (v.terminalTimezoneOffsetMinutes !== null && (!Number.isInteger(v.terminalTimezoneOffsetMinutes) || Math.abs(Number(v.terminalTimezoneOffsetMinutes)) > 840))
      || !['equity','freeMargin','totalVolume'].every(key => decimal(v[key]))
      || (typeof v.totalVolume === 'string' && v.totalVolume.startsWith('-'))
      || !['dailyLossPercent','drawdownPercent'].every(key => typeof v[key] === 'number' && Number.isFinite(v[key]) && v[key] >= 0)
      || (v.marginLevelPercent !== null && (typeof v.marginLevelPercent !== 'number' || !Number.isFinite(v.marginLevelPercent)))
      || !['openPositions','pendingOrders','dailyOpenCount','consecutiveLosses'].every(key => Number.isSafeInteger(v[key]) && Number(v[key]) >= 0)
      || !['lastSuccessfulOpenAt','cooldownUntil'].every(key => v[key] === null || iso(v[key]))) return fail()
    return structuredClone(v) as unknown as AccountRiskSummary
  } }
}
