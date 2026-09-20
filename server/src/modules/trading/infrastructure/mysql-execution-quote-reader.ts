import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { ExecutionQuoteReader } from '../application/execution-quote-reader.js'
import type { TerminalFactRouteGuard } from '../application/terminal-fact-route-guard.js'
import { executionSourceAvailable, executionProjectionState } from './mysql-execution-source-evidence.js'
const price = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,28})(\.[0-9]{1,18})?$/.test(value) && /[1-9]/.test(value)

export function createMysqlExecutionQuoteReader(connection: PoolConnection, guard: TerminalFactRouteGuard): ExecutionQuoteReader {
  return { async read(input) {
    const scope=structuredClone(input),route=scope.route
    if (typeof scope.symbol !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(scope.symbol)) return null
    if (!await executionSourceAvailable(connection,guard,route,scope.maxAgeMs)) return null
    const [rows]=await connection.execute<RowDataPacket[]>(`SELECT snap.symbol,CAST(snap.bid AS CHAR) bid,CAST(snap.ask AS CHAR) ask,
      snap.revision,pr.revision projection_revision,pp.projection_revision source_revision,
      DATE_FORMAT(snap.observed_at_utc,'%Y-%m-%dT%H:%i:%s.%fZ') observed_at,
      DATE_FORMAT(pp.observed_at_utc,'%Y-%m-%dT%H:%i:%s.%fZ') source_observed_at,
      TIMESTAMPDIFF(MICROSECOND,snap.observed_at_utc,UTC_TIMESTAMP(3)) age_us,
      TIMESTAMPDIFF(MICROSECOND,pp.observed_at_utc,UTC_TIMESTAMP(3)) source_age_us
      FROM market_quotes snap INNER JOIN trading_projection_revisions pr ON pr.trading_account_id=snap.trading_account_id
        AND pr.resource_kind='market.quote' AND pr.resource_id=snap.symbol
      INNER JOIN trading_projection_provenance_v4 pp ON pp.trading_account_id=pr.trading_account_id
        AND pp.resource_kind=pr.resource_kind AND pp.resource_id=pr.resource_id
      INNER JOIN trading_account_ownerships o ON o.trading_account_id=pr.trading_account_id AND o.user_id=pp.user_id
        AND o.interval_id=pp.ownership_interval_id AND o.revision=pp.ownership_revision AND o.role='owner' AND o.revoked_at_utc IS NULL
      WHERE snap.trading_account_id=? AND pp.user_id=? AND pp.ownership_revision=?
        AND pp.terminal_profile_id=? AND pp.terminal_instance_id=? AND pp.connection_epoch=? AND snap.symbol=? LIMIT 2 FOR SHARE`,
    [route.accountId,route.userId,route.ownershipRevision!,route.terminalProfileId,route.terminalInstanceId,route.connectionEpoch,scope.symbol])
    const row=rows[0],state=executionProjectionState(row,scope.maxAgeMs)
    if (rows.length !== 1 || !row || !state || row.symbol !== scope.symbol || !price(row.bid) || !price(row.ask)) return null
    return {accountId:route.accountId,symbol:scope.symbol,bid:row.bid,ask:row.ask,...state}
  } }
}
