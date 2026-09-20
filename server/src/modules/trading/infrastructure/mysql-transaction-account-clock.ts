import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { AccountClock } from '../domain/account-clock.js'

// Read in the caller's short business transaction. A cached clock is usable
// only while its account ownership, terminal binding and projection agree.
export async function readTransactionAccountClock(connection: PoolConnection, userId: number, accountId: string): Promise<AccountClock | null> {
  const [rows] = await connection.execute<(RowDataPacket & { timezone_offset_minutes: number | null; clock_status: AccountClock['clockStatus'] })[]>(`SELECT snap.timezone_offset_minutes,snap.clock_status
    FROM trading_accounts a
    INNER JOIN trading_account_ownerships own ON own.trading_account_id=a.id AND own.user_id=?
      AND own.role='owner' AND own.revoked_at_utc IS NULL AND own.revision=a.ownership_revision
    INNER JOIN trading_account_ownership_intervals oi ON oi.id=own.interval_id AND oi.user_id=own.user_id
      AND oi.trading_account_id=a.id AND oi.role='owner' AND oi.ended_at_utc IS NULL
      AND oi.started_at_utc=own.granted_at_utc AND oi.started_at_utc<=UTC_TIMESTAMP(3)
    INNER JOIN users u ON u.id=own.user_id AND u.deletion_status='active' AND u.deleted_at IS NULL
    INNER JOIN terminal_account_bindings b ON b.trading_account_id=a.id AND b.unbound_at_utc IS NULL
    INNER JOIN terminal_profiles p ON p.id=b.terminal_profile_id AND p.user_id=own.user_id
      AND p.platform=a.platform AND p.deleted_at_utc IS NULL
    INNER JOIN account_runtime_snapshots snap ON snap.trading_account_id=a.id
    INNER JOIN trading_projection_revisions pr ON pr.trading_account_id=a.id
      AND pr.resource_kind='account.metrics' AND pr.resource_id='current' AND pr.revision=snap.revision
    INNER JOIN trading_projection_provenance_v4 pp ON pp.trading_account_id=a.id
      AND pp.resource_kind=pr.resource_kind AND pp.resource_id=pr.resource_id AND pp.projection_revision=pr.revision
      AND pp.user_id=own.user_id AND pp.ownership_interval_id=own.interval_id AND pp.ownership_revision=a.ownership_revision
      AND pp.terminal_profile_id=b.terminal_profile_id AND pp.terminal_instance_id=b.terminal_instance_id
    WHERE a.id=? AND a.deleted_at_utc IS NULL
      AND NOT EXISTS (SELECT 1 FROM terminal_account_bindings other WHERE other.trading_account_id=a.id
        AND other.unbound_at_utc IS NULL AND other.terminal_profile_id<>b.terminal_profile_id)
      AND NOT EXISTS (SELECT 1 FROM bridge_connection_sessions session WHERE session.terminal_profile_id=b.terminal_profile_id
        AND session.disconnected_at_utc IS NULL AND session.connection_epoch_v4<>pp.connection_epoch)
    FOR SHARE`, [userId, accountId])
  return rows.length === 1 ? { timezoneOffsetMinutes: rows[0]!.timezone_offset_minutes, clockStatus: rows[0]!.clock_status } : null
}
