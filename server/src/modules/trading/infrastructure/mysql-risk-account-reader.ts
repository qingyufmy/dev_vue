import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { TerminalFactRoute } from '../application/terminal-fact-route-guard.js'
import { assertTerminalFactRoute, readExecutionPendingSnapshot } from './mysql-trading-repository.js'
import { createMysqlExecutionAccountReader } from './mysql-execution-account-reader.js'
import { createMysqlExecutionPositionCollectionReader } from './mysql-execution-position-collection-reader.js'

export function createMysqlRiskAccountReader(connection: PoolConnection) {
  return { async read(historicalRoute: TerminalFactRoute) {
    // History receipts intentionally omit device credentials. Resolve current proof separately;
    // the strict route guard below still checks ownership, binding, epoch and revocation.
    const [proofs] = await connection.execute<RowDataPacket[]>(`SELECT p.installation_id,s.generation
      FROM terminal_profiles p JOIN bridge_refresh_sessions s ON s.profile_id=p.id AND s.user_id=p.user_id
        AND s.installation_id=p.installation_id AND s.credential_version=4 AND s.revoked_at IS NULL
      WHERE p.id=? AND p.user_id=? AND p.deleted_at_utc IS NULL FOR SHARE`, [historicalRoute.terminalProfileId, historicalRoute.userId])
    if (proofs.length !== 1) return null
    const route = { ...historicalRoute, installationId: String(proofs[0]!.installation_id), credentialGeneration: Number(proofs[0]!.generation) }
    const guard = { assert: (value: TerminalFactRoute) => assertTerminalFactRoute(connection, value) }
    const account = await createMysqlExecutionAccountReader(connection, guard).read({ route, maxAgeMs: 30000 })
    if (!account || account.account.clockStatus !== 'calibrated' || account.account.timezoneOffsetMinutes === null) return null
    const positions = await createMysqlExecutionPositionCollectionReader(connection, guard).read({ route, maxAgeMs: 30000 })
    const pending = await readExecutionPendingSnapshot(connection, { userId: route.userId, accountId: route.accountId,
      terminalInstanceId: route.terminalInstanceId, brokerServer: route.brokerServer, login: route.login,
      connectionEpoch: String(route.connectionEpoch), ownershipRevision: route.ownershipRevision! })
    if (!positions || !pending) return null
    const [rows] = await connection.execute<RowDataPacket[]>(`SELECT snap.balance,snap.equity,snap.margin_amount,snap.free_margin,
      snap.floating_profit,CAST(o.interval_id AS CHAR) interval_id,UNIX_TIMESTAMP(UTC_TIMESTAMP(3))*1000 now_msc
      FROM account_runtime_snapshots snap JOIN trading_account_ownerships o ON o.trading_account_id=snap.trading_account_id
      WHERE snap.trading_account_id=? AND snap.revision=? AND o.user_id=? AND o.role='owner' AND o.revoked_at_utc IS NULL FOR SHARE`,
    [route.accountId, account.account.revision, route.userId])
    if (rows.length !== 1) return null
    const row = rows[0]!, now = Number(row.now_msc)
    if (now - Date.parse(pending.observedAt) > 30000 || now < Date.parse(pending.observedAt)) return null
    return { ...account.account, balance: String(row.balance), equity: String(row.equity), margin: String(row.margin_amount),
      freeMargin: String(row.free_margin), floatingPnl: String(row.floating_profit), ownershipIntervalId: String(row.interval_id),
      positions: positions.positions, pendingOrders: pending.items, now }
  } }
}
