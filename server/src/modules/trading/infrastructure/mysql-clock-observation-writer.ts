import type { PoolConnection } from 'mysql2/promise'
import type { TrustedBridgeProjectionWrite } from '../application/trading-ports.js'
import { resolveAccountClock, type AccountClock } from '../domain/account-clock.js'
import { TradingAccessError } from '../domain/trading.js'
import { sha256Canonical } from '../../../shared/canonical-json.js'

/** Caller holds route/revision locks; original observation and current projection commit together. */
export async function appendClockObservation(connection: Pick<PoolConnection, 'execute'>,
  input: TrustedBridgeProjectionWrite, ownership: { intervalId: string; ownershipRevision: string }, effective: AccountClock) {
  if (input.projection.resource !== 'account.metrics') return
  const { route, projection } = structuredClone(input)
  if (projection.resource !== 'account.metrics') return
  const data = projection.data
  if (route.accountId !== projection.accountId || data.id !== route.accountId
    || !Number.isSafeInteger(projection.revision) || projection.revision < 1 || data.revision !== projection.revision
    || !Number.isFinite(Date.parse(data.observedAt)) || new Date(data.observedAt).toISOString() !== data.observedAt) {
    throw new TradingAccessError('trading_context_invalid', 400)
  }
  resolveAccountClock(data, null)
  resolveAccountClock(effective, null)
  const evidence = { accountId: route.accountId, revision: projection.revision, userId: route.userId,
    ownershipIntervalId: ownership.intervalId, ownershipRevision: ownership.ownershipRevision,
    terminalProfileId: route.terminalProfileId, terminalInstanceId: route.terminalInstanceId,
    connectionEpoch: route.connectionEpoch, connectionId: route.connectionId ?? null,
    reportedOffsetMinutes: data.timezoneOffsetMinutes, reportedStatus: data.clockStatus,
    effectiveOffsetMinutes: effective.timezoneOffsetMinutes, effectiveStatus: effective.clockStatus, observedAt: data.observedAt }
  await connection.execute(`INSERT INTO terminal_clock_observations_v4
    (trading_account_id,projection_revision,user_id,ownership_interval_id,ownership_revision,
      terminal_profile_id,terminal_instance_id,connection_epoch,connection_id,reported_offset_minutes,
      reported_status,effective_offset_minutes,effective_status,observed_at_utc,received_at_utc,evidence_sha256)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,UTC_TIMESTAMP(3),?)`,
  [evidence.accountId,evidence.revision,evidence.userId,evidence.ownershipIntervalId,evidence.ownershipRevision,
    evidence.terminalProfileId,evidence.terminalInstanceId,evidence.connectionEpoch,evidence.connectionId,
    evidence.reportedOffsetMinutes,evidence.reportedStatus,evidence.effectiveOffsetMinutes,evidence.effectiveStatus,
    evidence.observedAt.replace('T',' ').replace('Z',''),sha256Canonical(evidence)])
}
