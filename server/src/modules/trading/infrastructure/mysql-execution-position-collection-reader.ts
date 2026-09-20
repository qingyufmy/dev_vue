import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { ExecutionPositionCollectionReader, ExecutionPositionCollectionScope, ExecutionPositionCollection } from '../application/execution-position-reader.js'
import type { TerminalFactRouteGuard } from '../application/terminal-fact-route-guard.js'
import { TradingAccessError } from '../domain/trading.js'

interface SourceRow extends RowDataPacket { revision: number | string; projection_revision: number | string; observed_at: string; age_us: number | string }
interface PositionRow extends RowDataPacket { ticket: string; revision: number | string; payload_json: string | Record<string, unknown> }
const positiveId = (value: unknown): value is string => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n
const volume = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,28})(\.[0-9]{1,18})?$/.test(value) && /[1-9]/.test(value)
const fresh = (age: unknown, maxAgeMs: number) => (typeof age === 'number' || (typeof age === 'string' && /^-?[0-9]+$/.test(age)))
  && Number.isSafeInteger(Number(age)) && Number(age) >= 0 && Number(age) <= maxAgeMs * 1000

export function createMysqlExecutionPositionCollectionReader(connection: PoolConnection, routeGuard: TerminalFactRouteGuard): ExecutionPositionCollectionReader {
  return { async read(input) {
    const scope: ExecutionPositionCollectionScope = structuredClone(input), route = scope.route
    if (typeof route.ownershipRevision !== 'string' || !positiveId(route.ownershipRevision) || route.platform !== 'mt5'
      || (scope.revision !== undefined && (!Number.isSafeInteger(scope.revision) || scope.revision < 1))
      || !Number.isSafeInteger(scope.maxAgeMs) || scope.maxAgeMs < 1 || scope.maxAgeMs > 60000) return null
    try { await routeGuard.assert(route) }
    catch (error) {
      if (error instanceof TradingAccessError && error.code === 'trading_context_invalid' && error.status === 403) return null
      throw error
    }
    // Credential/ownership/binding locks are retained by routeGuard on this same connection.
    const [enabled] = await connection.execute<RowDataPacket[]>(`SELECT a.id FROM trading_accounts a
      LEFT JOIN user_trading_account_settings settings ON settings.trading_account_id=a.id AND settings.user_id=?
      WHERE a.id=? AND COALESCE(settings.connection_paused,0)=0 FOR SHARE`, [route.userId,route.accountId])
    if (enabled.length !== 1) return null
    const [sessions] = await connection.execute<RowDataPacket[]>(`SELECT TIMESTAMPDIFF(MICROSECOND,last_seen_at_utc,UTC_TIMESTAMP(3)) age_us
      FROM bridge_connection_sessions WHERE user_id=? AND trading_account_id=? AND terminal_profile_id=?
        AND terminal_instance_id=? AND connection_epoch_v4=? AND connection_epoch=? AND disconnected_at_utc IS NULL FOR SHARE`,
    [route.userId,route.accountId,route.terminalProfileId,route.terminalInstanceId,route.connectionEpoch,`v4:${route.connectionId}`])
    if (sessions.length !== 1 || !fresh(sessions[0]!.age_us,scope.maxAgeMs)) return null
    const [sources] = await connection.execute<SourceRow[]>(`SELECT pr.revision,pp.projection_revision,
      DATE_FORMAT(pp.observed_at_utc,'%Y-%m-%dT%H:%i:%s.%fZ') observed_at,
      TIMESTAMPDIFF(MICROSECOND,pp.observed_at_utc,UTC_TIMESTAMP(3)) age_us
      FROM trading_projection_revisions pr INNER JOIN trading_projection_provenance_v4 pp
        ON pp.trading_account_id=pr.trading_account_id AND pp.resource_kind=pr.resource_kind AND pp.resource_id=pr.resource_id
      INNER JOIN trading_account_ownerships o ON o.trading_account_id=pr.trading_account_id AND o.user_id=pp.user_id
        AND o.interval_id=pp.ownership_interval_id AND o.revision=pp.ownership_revision AND o.role='owner' AND o.revoked_at_utc IS NULL
      WHERE pr.trading_account_id=? AND pr.resource_kind='positions' AND pr.resource_id='open'
        AND pp.user_id=? AND pp.ownership_revision=? AND pp.terminal_profile_id=? AND pp.terminal_instance_id=? AND pp.connection_epoch=? FOR SHARE`,
    [route.accountId,route.userId,route.ownershipRevision,route.terminalProfileId,route.terminalInstanceId,route.connectionEpoch])
    const source = sources[0]
    if (sources.length !== 1 || !source || !Number.isSafeInteger(Number(source.revision)) || Number(source.revision) < 1
      || (scope.revision !== undefined && Number(source.revision) !== scope.revision) || Number(source.projection_revision) !== Number(source.revision)
      || !fresh(source.age_us,scope.maxAgeMs) || typeof source.observed_at !== 'string' || !/\.\d{3}000Z$/.test(source.observed_at)) return null
    const revision = Number(source.revision), observedAt = source.observed_at.replace(/(\.\d{3})000Z$/, '$1Z')
    if (!Number.isFinite(Date.parse(observedAt)) || new Date(observedAt).toISOString() !== observedAt) return null
    // Read the full replacement collection: filtering the requested ticket would hide mixed revisions or duplicate stable identities.
    const [rows] = await connection.execute<PositionRow[]>(`SELECT ticket,payload_json,revision FROM open_position_snapshots
      WHERE trading_account_id=? ORDER BY ticket LIMIT 10001 FOR SHARE`, [route.accountId])
    if (rows.length > 10000) return null
    const tickets = new Set<string>(), identifiers = new Set<string>()
    const positions: (ExecutionPositionCollection['positions'][number])[] = []
    for (const row of rows) {
      let item: Record<string, unknown>
      try { item = typeof row.payload_json === 'string' ? JSON.parse(row.payload_json) as Record<string, unknown> : row.payload_json }
      catch { return null }
      if (!item || typeof item !== 'object' || Array.isArray(item) || item.accountId !== route.accountId
        || Number(row.revision) !== revision || item.revision !== revision
        || !positiveId(item.ticket) || item.ticket !== String(row.ticket) || tickets.has(item.ticket)
        || typeof item.symbol !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(item.symbol)
        || (item.side !== 'buy' && item.side !== 'sell') || !volume(item.volume)) return null
      tickets.add(item.ticket)
      if (item.positionIdentifier !== undefined && item.positionIdentifier !== null) {
        if (!positiveId(item.positionIdentifier) || identifiers.has(item.positionIdentifier)) return null
        identifiers.add(item.positionIdentifier)
      }
      positions.push({ accountId: route.accountId, ticket: item.ticket, positionIdentifier: item.positionIdentifier as string | null ?? null,
        symbol: item.symbol, side: item.side, volume: item.volume,
        // Never turn absent or malformed protection into an explicit unprotected position.
        ...(item.stopLoss === null || volume(item.stopLoss) ? { stopLoss: item.stopLoss } : {}),
        ...(item.takeProfit === null || volume(item.takeProfit) ? { takeProfit: item.takeProfit } : {}) })
    }
    return { accountId: route.accountId, revision, observedAt, positions }
  } }
}
