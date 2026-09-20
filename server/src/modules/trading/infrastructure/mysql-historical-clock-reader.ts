import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { HistoricalClockBoundaryReader } from '../application/historical-clock-reader.js'
import { sha256Canonical } from '../../../shared/canonical-json.js'

/** Versioned bounded-observation policy, not an inferred broker DST calendar. */
export const historicalClockBoundaryPolicy = { version: 'clock-boundary:v1', maxGapMsc: 300_000 } as const
const utc = (value: number) => new Date(value).toISOString().slice(0,23).replace('T',' ')
const columns = `CAST(trading_account_id AS CHAR) account_id,CAST(projection_revision AS CHAR) revision,user_id,
  ownership_interval_id,CAST(ownership_revision AS CHAR) ownership_revision,terminal_profile_id,terminal_instance_id,
  CAST(connection_epoch AS CHAR) connection_epoch,connection_id,reported_offset_minutes,reported_status,
  effective_offset_minutes,effective_status,observed_at_utc,evidence_sha256`

function verified(row: RowDataPacket | undefined) {
  if (!row) return null
  const time = row.observed_at_utc instanceof Date ? row.observed_at_utc.getTime()
    : Date.parse(String(row.observed_at_utc).replace(' ','T') + 'Z')
  if (!Number.isSafeInteger(time)
    || !Number.isSafeInteger(Number(row.revision)) || !Number.isSafeInteger(Number(row.connection_epoch))) return null
  const observedAt = new Date(time).toISOString()
  const evidence = { accountId: String(row.account_id), revision: Number(row.revision), userId: Number(row.user_id),
    ownershipIntervalId: String(row.ownership_interval_id), ownershipRevision: String(row.ownership_revision),
    terminalProfileId: String(row.terminal_profile_id), terminalInstanceId: String(row.terminal_instance_id),
    connectionEpoch: Number(row.connection_epoch), connectionId: row.connection_id,
    reportedOffsetMinutes: row.reported_offset_minutes, reportedStatus: row.reported_status,
    effectiveOffsetMinutes: row.effective_offset_minutes, effectiveStatus: row.effective_status, observedAt }
  if (sha256Canonical(evidence) !== row.evidence_sha256 || !evidence.connectionId
    || evidence.reportedStatus !== 'calibrated' || evidence.effectiveStatus !== 'calibrated'
    || !Number.isInteger(evidence.reportedOffsetMinutes) || Math.abs(evidence.reportedOffsetMinutes) > 840
    || evidence.reportedOffsetMinutes !== evidence.effectiveOffsetMinutes) return null
  return { evidence, time, hash: String(row.evidence_sha256) }
}

export function createMysqlHistoricalClockReader(connection: Pick<PoolConnection, 'execute'>): HistoricalClockBoundaryReader {
  const reader: HistoricalClockBoundaryReader = { async resolveLocal(input) {
    const scope = structuredClone(input), local = new Date(scope.localMidnightMsc)
    if (!Number.isSafeInteger(scope.localMidnightMsc) || scope.localMidnightMsc <= 0 || !Number.isFinite(local.getTime())
      || local.getUTCHours() !== 0 || local.getUTCMinutes() !== 0 || local.getUTCSeconds() !== 0 || local.getUTCMilliseconds() !== 0
      || !Number.isSafeInteger(scope.userId) || scope.userId < 1 || !/^[1-9]\d{0,19}$/.test(scope.accountId)
      || !scope.ownershipIntervalId || !Number.isSafeInteger(scope.asOfUtcMsc) || scope.asOfUtcMsc <= 0) throw Error('historical_clock_scope_invalid')
    const margin = 840 * 60_000 + historicalClockBoundaryPolicy.maxGapMsc
    const [rows] = await connection.execute<RowDataPacket[]>(`SELECT DISTINCT reported_offset_minutes offset_minutes
      FROM terminal_clock_observations_v4 WHERE trading_account_id=? AND ownership_interval_id=?
        AND observed_at_utc BETWEEN ? AND ? AND received_at_utc<=? AND reported_status='calibrated'
      ORDER BY reported_offset_minutes LIMIT 17`, [scope.accountId,scope.ownershipIntervalId,
      utc(scope.localMidnightMsc-margin),utc(scope.localMidnightMsc+margin),utc(scope.asOfUtcMsc)])
    if (rows.length > 16) return null
    const matches = []
    for (const row of rows) {
      const offset = row.offset_minutes
      if (!Number.isInteger(offset) || Math.abs(offset) > 840) return null
      const utcMsc = scope.localMidnightMsc-offset*60_000
      if (utcMsc > scope.asOfUtcMsc) continue
      const result = await reader.read({ ...scope, utcMsc })
      if (result && result.offsetMinutes === offset) matches.push(result)
    }
    return matches.length === 1 ? matches[0]! : null
  }, async read(input) {
    const scope = structuredClone(input)
    if (!Number.isSafeInteger(scope.userId) || scope.userId < 1 || !/^[1-9]\d{0,19}$/.test(scope.accountId)
      || !scope.ownershipIntervalId || !Number.isSafeInteger(scope.utcMsc) || scope.utcMsc <= 0
      || !Number.isSafeInteger(scope.asOfUtcMsc) || scope.asOfUtcMsc < scope.utcMsc) throw Error('historical_clock_scope_invalid')
    const parameters = [scope.accountId, scope.ownershipIntervalId, utc(scope.utcMsc), utc(scope.asOfUtcMsc)]
    // Do not filter by status/route/user first: a nearer incompatible observation invalidates the bracket.
    const [left] = await connection.execute<RowDataPacket[]>(`SELECT ${columns} FROM terminal_clock_observations_v4
      WHERE trading_account_id=? AND ownership_interval_id=? AND observed_at_utc<=? AND received_at_utc<=?
      ORDER BY observed_at_utc DESC,projection_revision DESC LIMIT 1 FOR SHARE`, parameters)
    const [right] = await connection.execute<RowDataPacket[]>(`SELECT ${columns} FROM terminal_clock_observations_v4
      WHERE trading_account_id=? AND ownership_interval_id=? AND observed_at_utc>=? AND received_at_utc<=?
        AND observed_at_utc<=?
      ORDER BY observed_at_utc ASC,projection_revision DESC LIMIT 1 FOR SHARE`, [...parameters,utc(scope.asOfUtcMsc)])
    const before = verified(left[0]), after = verified(right[0])
    if (!before || !after || before.evidence.userId !== scope.userId || after.evidence.userId !== scope.userId
      || before.time > scope.utcMsc || after.time < scope.utcMsc
      || scope.utcMsc - before.time > historicalClockBoundaryPolicy.maxGapMsc
      || after.time - scope.utcMsc > historicalClockBoundaryPolicy.maxGapMsc
      || before.evidence.revision > after.evidence.revision) return null
    for (const key of ['ownershipRevision','terminalProfileId','terminalInstanceId','connectionEpoch','connectionId','reportedOffsetMinutes'] as const) {
      if (before.evidence[key] !== after.evidence[key]) return null
    }
    return { utcMsc: scope.utcMsc, offsetMinutes: before.evidence.reportedOffsetMinutes,
      evidenceRef: `${historicalClockBoundaryPolicy.version}:${sha256Canonical({ policy: historicalClockBoundaryPolicy,
        utcMsc: scope.utcMsc, before: before.hash, after: after.hash })}` }
  } }
  return reader
}
