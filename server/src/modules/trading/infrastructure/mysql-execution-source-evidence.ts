import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { TerminalFactRoute, TerminalFactRouteGuard } from '../application/terminal-fact-route-guard.js'
import { TradingAccessError } from '../domain/trading.js'

const ageLimit = (value: number) => Number.isSafeInteger(value) && value >= 1 && value <= 60000
const fresh = (value: unknown, limit: number) => (typeof value === 'number' || (typeof value === 'string' && /^-?[0-9]+$/.test(value)))
  && Number.isSafeInteger(Number(value)) && Number(value) >= 0 && Number(value) <= limit * 1000
function timestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !/\.\d{3}000Z$/.test(value)) return null
  const result = value.replace(/(\.\d{3})000Z$/, '$1Z')
  return Number.isFinite(Date.parse(result)) && new Date(result).toISOString() === result ? result : null
}
export function executionProjectionState(row: RowDataPacket | undefined, maxAgeMs: number) {
  if (!row || !Number.isSafeInteger(Number(row.revision)) || Number(row.revision) < 1
    || Number(row.projection_revision) !== Number(row.revision) || Number(row.source_revision) !== Number(row.revision)
    || !fresh(row.age_us,maxAgeMs) || !fresh(row.source_age_us,maxAgeMs)) return null
  const observedAt = timestamp(row.observed_at), sourceAt = timestamp(row.source_observed_at)
  if (!observedAt || sourceAt !== observedAt) return null
  return {revision:Number(row.revision),observedAt}
}

/** Reused current-session authorization for account and quote facts; caller owns the SQL transaction. */
export async function executionSourceAvailable(connection: PoolConnection, guard: TerminalFactRouteGuard,
  route: TerminalFactRoute, maxAgeMs: number): Promise<boolean> {
    if (route.platform !== 'mt5' || typeof route.ownershipRevision !== 'string' || !/^[1-9][0-9]{0,19}$/.test(route.ownershipRevision)
      || BigInt(route.ownershipRevision) > 18446744073709551615n
      || !ageLimit(maxAgeMs)) return false
    try { await guard.assert(route) }
    catch(error) {
      if (error instanceof TradingAccessError && error.code === 'trading_context_invalid' && error.status === 403) return false
      throw error
    }
    const [sessions] = await connection.execute<RowDataPacket[]>(`SELECT TIMESTAMPDIFF(MICROSECOND,s.last_seen_at_utc,UTC_TIMESTAMP(3)) age_us
      FROM bridge_connection_sessions s LEFT JOIN user_trading_account_settings settings ON settings.trading_account_id=s.trading_account_id AND settings.user_id=s.user_id
      WHERE s.user_id=? AND s.trading_account_id=? AND s.terminal_profile_id=? AND s.terminal_instance_id=?
        AND s.connection_epoch_v4=? AND s.connection_epoch=? AND s.disconnected_at_utc IS NULL
        AND COALESCE(settings.connection_paused,0)=0 LIMIT 2 FOR SHARE`,
    [route.userId,route.accountId,route.terminalProfileId,route.terminalInstanceId,route.connectionEpoch,`v4:${route.connectionId}`])
    if (sessions.length !== 1 || !fresh(sessions[0]!.age_us,maxAgeMs)) return false
  return true
}
