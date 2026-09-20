import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { ExecutionAccountReader } from '../application/execution-account-reader.js'
import type { TerminalFactRoute, TerminalFactRouteGuard } from '../application/terminal-fact-route-guard.js'
import { executionSourceAvailable, executionProjectionState } from './mysql-execution-source-evidence.js'

// Read provenance together with the persisted account projection under shared locks.
function projectionQuery() {
  return `SELECT snap.revision,pr.revision projection_revision,pp.projection_revision source_revision,
    snap.trade_permission,snap.timezone_offset_minutes,snap.clock_status,
    DATE_FORMAT(snap.observed_at_utc,'%Y-%m-%dT%H:%i:%s.%fZ') observed_at,
    DATE_FORMAT(pp.observed_at_utc,'%Y-%m-%dT%H:%i:%s.%fZ') source_observed_at,
    TIMESTAMPDIFF(MICROSECOND,snap.observed_at_utc,UTC_TIMESTAMP(3)) age_us,
    TIMESTAMPDIFF(MICROSECOND,pp.observed_at_utc,UTC_TIMESTAMP(3)) source_age_us
    FROM account_runtime_snapshots snap
    INNER JOIN trading_projection_revisions pr ON pr.trading_account_id=snap.trading_account_id
      AND pr.resource_kind='account.metrics' AND pr.resource_id='current'
    INNER JOIN trading_projection_provenance_v4 pp ON pp.trading_account_id=pr.trading_account_id
      AND pp.resource_kind=pr.resource_kind AND pp.resource_id=pr.resource_id
    INNER JOIN trading_account_ownerships o ON o.trading_account_id=pr.trading_account_id AND o.user_id=pp.user_id
      AND o.interval_id=pp.ownership_interval_id AND o.revision=pp.ownership_revision AND o.role='owner' AND o.revoked_at_utc IS NULL
    WHERE snap.trading_account_id=? AND pp.user_id=? AND pp.ownership_revision=?
      AND pp.terminal_profile_id=? AND pp.terminal_instance_id=? AND pp.connection_epoch=?
      LIMIT 2 FOR SHARE`
}
const sourceParameters = (route: TerminalFactRoute, ownershipRevision: string) => [route.accountId,route.userId,ownershipRevision,route.terminalProfileId,route.terminalInstanceId,route.connectionEpoch]
export function createMysqlExecutionAccountReader(connection: PoolConnection, guard: TerminalFactRouteGuard): ExecutionAccountReader {
  return { async read(input) {
    const scope = structuredClone(input), route = scope.route
    if (!await executionSourceAvailable(connection,guard,route,scope.maxAgeMs)) return null
    const [accounts] = await connection.execute<RowDataPacket[]>(projectionQuery(),sourceParameters(route,route.ownershipRevision!))
    const accountRow=accounts[0], accountState=executionProjectionState(accountRow,scope.maxAgeMs)
    if (accounts.length !== 1 || !accountRow || !accountState || ![0,1].includes(accountRow.trade_permission)
      || !['calibrated','observer_bootstrap','stale','unavailable'].includes(accountRow.clock_status)
      || (accountRow.timezone_offset_minutes !== null && (!Number.isInteger(accountRow.timezone_offset_minutes) || Math.abs(accountRow.timezone_offset_minutes) > 840))) return null
    return {accountId:route.accountId,account:{...accountState,tradePermission:accountRow.trade_permission === 1,
      timezoneOffsetMinutes:accountRow.timezone_offset_minutes,clockStatus:accountRow.clock_status}}
  } }
}
