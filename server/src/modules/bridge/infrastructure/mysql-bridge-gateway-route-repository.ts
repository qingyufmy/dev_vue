import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { BridgeGatewayRouteRepository } from '../application/bridge-gateway-ports.js'
import { BridgeGatewayError, type BridgeGatewayRoute } from '../domain/bridge-gateway.js'

interface AccountRow extends RowDataPacket { id: string | number; platform: 'mt4' | 'mt5' }
interface EpochRow extends RowDataPacket { connection_epoch_v4: string | number }

export class MysqlBridgeGatewayRouteRepository implements BridgeGatewayRouteRepository {
  constructor(private readonly pool: Pool) {}

  async authorizeAndOpen(input: Parameters<BridgeGatewayRouteRepository['authorizeAndOpen']>[0]) {
    return transaction(this.pool, async connection => {
      const terminal = input.hello.payload.terminals[0]!
      const wire = terminal.route
      const [accounts] = await connection.execute<AccountRow[]>(`SELECT id,platform FROM trading_accounts
        WHERE BINARY broker_server=BINARY ? AND BINARY account_login=BINARY ? AND deleted_at_utc IS NULL
        LIMIT 1 FOR UPDATE`, [wire.account_ref.broker_server, wire.account_ref.login])
      const account = accounts[0]
      if (!account || account.platform !== terminal.platform) throw new BridgeGatewayError('bridge_route_account_not_found', 403)
      const accountId = String(account.id)
      const [authorized] = await connection.execute<RowDataPacket[]>(`SELECT p.id FROM terminal_profiles p
        INNER JOIN terminal_account_bindings b ON b.terminal_profile_id=p.id AND b.trading_account_id=?
          AND b.terminal_instance_id=? AND b.unbound_at_utc IS NULL
        INNER JOIN trading_account_ownerships o ON o.trading_account_id=b.trading_account_id
          AND o.user_id=p.user_id AND o.role='owner' AND o.revoked_at_utc IS NULL
        WHERE p.id=? AND p.user_id=? AND p.installation_id=? AND p.platform=? AND p.deleted_at_utc IS NULL
        LIMIT 1 FOR UPDATE`, [
        accountId, wire.terminal_instance_id, input.claims.profileId, input.claims.userId,
        input.claims.installationId, terminal.platform,
      ])
      if (!authorized[0]) throw new BridgeGatewayError('bridge_route_binding_invalid', 403)
      const [prior] = await connection.execute<EpochRow[]>(`SELECT connection_epoch_v4 FROM bridge_connection_sessions
        WHERE terminal_instance_id=? AND connection_epoch_v4 IS NOT NULL
        ORDER BY connection_epoch_v4 DESC LIMIT 1 FOR UPDATE`, [wire.terminal_instance_id])
      if (prior[0] && Number(prior[0].connection_epoch_v4) >= wire.connection_epoch) {
        throw new BridgeGatewayError('bridge_connection_epoch_stale', 409)
      }
      await connection.execute(`INSERT INTO bridge_connection_sessions
        (user_id,trading_account_id,terminal_profile_id,terminal_instance_id,connection_epoch,connection_epoch_v4,connected_at_utc,last_seen_at_utc,disconnected_at_utc,disconnect_reason)
        VALUES (?,?,?,?,?,?,?,?,?,'bridge_session_pending')`, [
        input.claims.userId, accountId, input.claims.profileId, wire.terminal_instance_id,
        `v4:${input.connectionId}`, wire.connection_epoch, input.connectedAt, input.connectedAt, input.connectedAt,
      ])
      return {
        userId: input.claims.userId,
        accountId,
        terminalProfileId: input.claims.profileId,
        terminalInstanceId: wire.terminal_instance_id,
        brokerServer: wire.account_ref.broker_server,
        login: wire.account_ref.login,
        connectionEpoch: wire.connection_epoch,
        connectionId: input.connectionId,
        sessionId: input.hello.payload.session_id,
      } satisfies BridgeGatewayRoute
    })
  }

  async activate(route: BridgeGatewayRoute, activatedAt: string) {
    await transaction(this.pool, async connection => {
      const [current] = await connection.execute<RowDataPacket[]>(`SELECT id FROM bridge_connection_sessions
        WHERE user_id=? AND trading_account_id=? AND terminal_profile_id=? AND terminal_instance_id=?
          AND connection_epoch_v4=? AND disconnect_reason='bridge_session_pending' LIMIT 1 FOR UPDATE`, [
        route.userId, route.accountId, route.terminalProfileId, route.terminalInstanceId, route.connectionEpoch,
      ])
      if (!current[0]) throw new BridgeGatewayError('bridge_session_open_missing', 409)
      const [latest] = await connection.execute<EpochRow[]>(`SELECT connection_epoch_v4 FROM bridge_connection_sessions
        WHERE terminal_instance_id=? AND connection_epoch_v4 IS NOT NULL
        ORDER BY connection_epoch_v4 DESC LIMIT 1 FOR UPDATE`, [route.terminalInstanceId])
      if (Number(latest[0]?.connection_epoch_v4) !== route.connectionEpoch) {
        throw new BridgeGatewayError('bridge_connection_epoch_superseded', 409)
      }
      await connection.execute(`UPDATE bridge_connection_sessions
        SET disconnected_at_utc=?,disconnect_reason='bridge_connection_replaced'
        WHERE user_id=? AND disconnected_at_utc IS NULL AND (connection_epoch_v4 IS NULL OR connection_epoch_v4<>?)
          AND (trading_account_id=? OR terminal_profile_id=?)`, [
        activatedAt, route.userId, route.connectionEpoch, route.accountId, route.terminalProfileId,
      ])
      await connection.execute(`UPDATE bridge_connection_sessions
        SET disconnected_at_utc=NULL,disconnect_reason=NULL,last_seen_at_utc=?
        WHERE user_id=? AND trading_account_id=? AND terminal_profile_id=? AND terminal_instance_id=? AND connection_epoch_v4=?`, [
        activatedAt, route.userId, route.accountId, route.terminalProfileId, route.terminalInstanceId, route.connectionEpoch,
      ])
    })
  }

  async touch(route: BridgeGatewayRoute, seenAt: string) {
    const [result] = await this.pool.execute<ResultSetHeader>(`UPDATE bridge_connection_sessions
      SET last_seen_at_utc=? WHERE user_id=? AND trading_account_id=? AND terminal_profile_id=?
        AND terminal_instance_id=? AND connection_epoch_v4=? AND disconnected_at_utc IS NULL`, [
      seenAt, route.userId, route.accountId, route.terminalProfileId, route.terminalInstanceId, route.connectionEpoch,
    ])
    return result.affectedRows === 1
  }

  async close(route: BridgeGatewayRoute, reason: string, disconnectedAt: string) {
    await this.pool.execute(`UPDATE bridge_connection_sessions SET disconnected_at_utc=?,disconnect_reason=?
      WHERE user_id=? AND trading_account_id=? AND terminal_profile_id=? AND terminal_instance_id=?
        AND connection_epoch_v4=? AND (disconnected_at_utc IS NULL OR disconnect_reason='bridge_session_pending')`, [
      disconnectedAt, reason.slice(0, 64), route.userId, route.accountId, route.terminalProfileId,
      route.terminalInstanceId, route.connectionEpoch,
    ])
  }
}

async function transaction<T>(pool: Pool, work: (connection: PoolConnection) => Promise<T>) {
  const connection = await pool.getConnection()
  try { await connection.beginTransaction(); const value = await work(connection); await connection.commit(); return value }
  catch (error) { await connection.rollback(); throw error }
  finally { connection.release() }
}
