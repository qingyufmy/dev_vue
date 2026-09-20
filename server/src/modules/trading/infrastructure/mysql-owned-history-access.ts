import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { ActivePrincipalAccess } from '../../auth/index.js'
import type { OwnedHistoryAccessReader } from '../application/owned-history-access.js'

function utc(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw Error('owned_history_scope_invalid')
  return value.slice(0, 23).replace('T', ' ')
}

export function createMysqlOwnedHistoryAccess(connection: Pick<PoolConnection, 'execute'>,
  principals: ActivePrincipalAccess): OwnedHistoryAccessReader {
  return { async read(input) {
    const scope = structuredClone(input), opened = utc(scope.openedAt), closed = utc(scope.closedAt)
    if (!Number.isSafeInteger(scope.userId) || scope.userId < 1 || !/^[1-9]\d{0,19}$/.test(scope.accountId)
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/.test(scope.ownershipIntervalId)
      || !['mt4', 'mt5'].includes(scope.platform) || opened > closed) throw Error('owned_history_scope_invalid')
    if (!await principals.isActive(scope.userId, 'share')) return null
    const [rows] = await connection.execute<(RowDataPacket & { revision: string; current_interval: string; historical_interval: string })[]>(
      `SELECT CAST(a.ownership_revision AS CHAR) revision,own.interval_id current_interval,hi.id historical_interval
       FROM trading_accounts a
       INNER JOIN trading_account_ownerships own ON own.trading_account_id=a.id AND own.user_id=?
         AND own.role='owner' AND own.revoked_at_utc IS NULL AND own.revision=a.ownership_revision
       INNER JOIN trading_account_ownership_intervals current_owner ON current_owner.id=own.interval_id
         AND current_owner.trading_account_id=a.id AND current_owner.user_id=own.user_id AND current_owner.role='owner'
         AND current_owner.ended_at_utc IS NULL AND current_owner.started_at_utc=own.granted_at_utc
         AND current_owner.started_at_utc<=UTC_TIMESTAMP(3)
       INNER JOIN trading_account_ownership_intervals hi ON hi.id=? AND hi.trading_account_id=a.id
         AND hi.user_id=own.user_id AND hi.role='owner' AND hi.started_at_utc<=?
         AND (hi.ended_at_utc IS NULL OR hi.ended_at_utc>?)
       WHERE a.id=? AND a.platform=? AND a.deleted_at_utc IS NULL AND ?<=UTC_TIMESTAMP(3)
         AND NOT EXISTS (SELECT 1 FROM trading_account_ownerships other WHERE other.trading_account_id=a.id
           AND other.role='owner' AND other.revoked_at_utc IS NULL AND other.user_id<>own.user_id)
         AND NOT EXISTS (SELECT 1 FROM trading_account_ownership_intervals conflict WHERE conflict.trading_account_id=a.id
           AND conflict.role='owner' AND conflict.id<>hi.id
           AND (conflict.ended_at_utc IS NULL OR conflict.ended_at_utc>conflict.started_at_utc)
           AND conflict.started_at_utc<=? AND (conflict.ended_at_utc IS NULL OR conflict.ended_at_utc>?))
       FOR SHARE`, [scope.userId,scope.ownershipIntervalId,opened,closed,scope.accountId,scope.platform,closed,closed,opened])
    if (rows.length !== 1) return null
    const row = rows[0]!
    if (!/^[1-9]\d*$/.test(row.revision)) throw Error('owned_history_revision_invalid')
    return { userId: scope.userId, accountId: scope.accountId, platform: scope.platform,
      currentOwnershipRevision: row.revision, currentOwnershipIntervalId: row.current_interval,
      historicalOwnershipIntervalId: row.historical_interval }
  } }
}
