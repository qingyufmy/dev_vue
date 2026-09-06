import { randomUUID } from 'node:crypto'
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { BridgeTerminalHello } from '../domain/bridge-gateway.js'
import { gatewayError } from './mysql-bridge-route-authorization.js'

export async function insertFirstAccount(
  connection: PoolConnection,
  platform: 'mt4' | 'mt5',
  facts: NonNullable<BridgeTerminalHello['account_facts']>,
  connectedAt: string,
) {
  const [inserted] = await connection.execute<ResultSetHeader>(`INSERT INTO trading_accounts
    (platform,broker_server,account_login,currency,ownership_revision,created_at_utc,updated_at_utc,deleted_at_utc)
    VALUES (?,?,?,?,1,?,?,NULL)`, [platform, facts.broker_server, facts.login, facts.currency, connectedAt, connectedAt])
  if (inserted.affectedRows !== 1) throw gatewayError('bridge_route_storage_unavailable', 503)
  // Preserve unsigned BIGINT identity without converting the driver's insertId to a JS number.
  const [rows] = await connection.execute<(RowDataPacket & { id: string })[]>(`SELECT CAST(LAST_INSERT_ID() AS CHAR) id`)
  const id = rows[0]?.id
  if (typeof id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(id)) throw gatewayError('bridge_route_storage_invalid', 503)
  return id
}

export async function insertFirstOwnership(connection: PoolConnection, userId: number, accountId: string, connectedAt: string) {
  const intervalId = randomUUID()
  const [interval] = await connection.execute<ResultSetHeader>(`INSERT INTO trading_account_ownership_intervals
    (id,user_id,trading_account_id,role,started_at_utc,ended_at_utc,end_reason,origin_kind,origin_ref,created_at_utc,updated_at_utc)
    VALUES (?,?,?,'owner',?,NULL,NULL,'runtime',?,?,?)`,
  [intervalId, userId, accountId, connectedAt, `bridge-first-account:${accountId}`, connectedAt, connectedAt])
  if (interval.affectedRows !== 1) throw gatewayError('bridge_route_storage_unavailable', 503)
  const [owner] = await connection.execute<ResultSetHeader>(`INSERT INTO trading_account_ownerships
    (user_id,trading_account_id,role,granted_at_utc,revoked_at_utc,interval_id,revision)
    VALUES (?,?,'owner',?,NULL,?,1)`, [userId, accountId, connectedAt, intervalId])
  if (owner.affectedRows !== 1) throw gatewayError('bridge_route_storage_unavailable', 503)
}
