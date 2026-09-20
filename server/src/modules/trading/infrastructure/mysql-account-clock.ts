import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { TrustedBridgeProjectionWrite } from '../application/trading-ports.js'
import { resolveAccountClock, type AccountClock } from '../domain/account-clock.js'

export async function resolveStoredAccountClock(
  connection: PoolConnection,
  input: TrustedBridgeProjectionWrite,
  ownership: { intervalId: string; ownershipRevision: string },
): Promise<AccountClock | undefined> {
  if (input.projection.resource !== 'account.metrics') return undefined
  const route = input.route
  // Account metrics arrive every second; absence of a new daily clock sample is not revocation.
  // Use the original observation timestamp so metrics cannot indefinitely renew the evidence.
  if (input.projection.data.clockStatus === 'unavailable' && input.projection.data.timezoneOffsetMinutes === null) {
    const [confirmed] = await connection.execute<RowDataPacket[]>(`SELECT reported_offset_minutes
      FROM terminal_clock_observations_v4
      WHERE trading_account_id=? AND user_id=? AND ownership_interval_id=? AND ownership_revision=?
        AND terminal_profile_id=? AND terminal_instance_id=?
        AND reported_status='calibrated' AND effective_status='calibrated'
        AND reported_offset_minutes=effective_offset_minutes
        AND observed_at_utc<=? AND observed_at_utc>=DATE_SUB(?,INTERVAL 24 HOUR)
      ORDER BY observed_at_utc DESC,projection_revision DESC LIMIT 1 FOR SHARE`,
    [route.accountId, route.userId, ownership.intervalId, ownership.ownershipRevision,
      route.terminalProfileId, route.terminalInstanceId, new Date(input.projection.data.observedAt), new Date(input.projection.data.observedAt)])
    if (confirmed.length === 1) {
      return resolveAccountClock({ timezoneOffsetMinutes: confirmed[0]!.reported_offset_minutes, clockStatus: 'calibrated' }, null)
    }
  }
  const [rows] = await connection.execute<(RowDataPacket & {
    timezone_offset_minutes: number | null; clock_status: AccountClock['clockStatus']
  })[]>(`SELECT snap.timezone_offset_minutes,snap.clock_status
    FROM account_runtime_snapshots snap
    INNER JOIN trading_projection_provenance_v4 pp ON pp.trading_account_id=snap.trading_account_id
      AND pp.resource_kind='account.metrics' AND pp.resource_id='current'
      AND pp.projection_revision=snap.revision
    INNER JOIN trading_projection_revisions pr ON pr.trading_account_id=pp.trading_account_id
      AND pr.resource_kind=pp.resource_kind AND pr.resource_id=pp.resource_id
      AND pr.revision=pp.projection_revision
    WHERE snap.trading_account_id=? AND pp.user_id=? AND pp.ownership_interval_id=?
      AND pp.ownership_revision=? AND pp.terminal_profile_id=? AND pp.terminal_instance_id=?
      AND pp.connection_epoch=?
    FOR UPDATE`, [route.accountId, route.userId, ownership.intervalId, ownership.ownershipRevision,
    route.terminalProfileId, route.terminalInstanceId, route.connectionEpoch])
  const previous = rows.length === 1 ? {
    timezoneOffsetMinutes: rows[0]!.timezone_offset_minutes, clockStatus: rows[0]!.clock_status,
  } : null
  return resolveAccountClock(input.projection.data, previous)
}
