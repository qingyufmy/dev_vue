import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import { contextWriteFingerprintInput, normalizeContextWrite, type ContextWriteCommand } from '../domain/context-write.js'
import { TradingAccessError } from '../domain/trading.js'
import type { ContextTargetResolver } from './mysql-context-commands.js'
import { MysqlObserverAccessReader } from './mysql-observer-access-reader.js'
import { MysqlTradingRepository } from './mysql-trading-repository.js'

type GatewayLeases = NonNullable<ConstructorParameters<typeof MysqlTradingRepository>[1]>

async function ownedTarget(executor: Pick<Pool, 'execute'>, command: ContextWriteCommand, lock: boolean) {
  const [rows] = await executor.execute<RowDataPacket[]>(`SELECT CAST(a.id AS CHAR) account_id
    FROM trading_accounts a
    INNER JOIN trading_account_ownerships o ON o.trading_account_id=a.id AND o.role='owner' AND o.revoked_at_utc IS NULL
    INNER JOIN trading_account_ownership_intervals oi ON oi.id=o.interval_id AND oi.user_id=o.user_id
      AND oi.trading_account_id=o.trading_account_id AND oi.role='owner' AND oi.ended_at_utc IS NULL
      AND oi.started_at_utc=o.granted_at_utc AND oi.started_at_utc<=UTC_TIMESTAMP(3)
    INNER JOIN users u ON u.id=o.user_id AND u.deletion_status='active' AND u.deleted_at IS NULL
    WHERE o.user_id=? AND a.deleted_at_utc IS NULL AND o.revision=a.ownership_revision
      ${command.action === 'select_account' ? 'AND a.id=?' : ''}
    ORDER BY a.id LIMIT 1${lock ? ' FOR SHARE' : ''}`, command.action === 'select_account' ? [command.userId, command.targetId] : [command.userId])
  return rows[0] ? String(rows[0].account_id) : null
}

// Capture the external route before entering a MySQL transaction. The resolver itself does only SQL.
export async function prepareMysqlContextTarget(
  pool: Pool, leases: GatewayLeases, input: ContextWriteCommand,
): Promise<ContextTargetResolver> {
  const command = Object.freeze(normalizeContextWrite(input)), fingerprint = contextWriteFingerprintInput(command)
  const candidate = command.action === 'enter_observer' ? null : await ownedTarget(pool, command, false)
  let route: Awaited<ReturnType<GatewayLeases['current']>> = null
  if (candidate) {
    try { route = structuredClone(await leases.current(candidate)) }
    catch { route = null }
  }
  const frozenLeases: GatewayLeases = { async current(accountId) {
    return accountId === candidate ? structuredClone(route) : null
  } }
  return async (connection: PoolConnection, currentCommand: ContextWriteCommand) => {
    if (contextWriteFingerprintInput(currentCommand) !== fingerprint) throw new TradingAccessError('trading_context_invalid', 400)
    const observer = new MysqlObserverAccessReader(connection)
    if (command.action === 'enter_observer') {
      if (!await observer.authorizeOn(connection, command.userId, command.targetId!)) throw new TradingAccessError('trading_account_forbidden', 403)
      return { userId: command.userId, mode: 'observer', accountId: null, observerChannelId: command.targetId, readOnly: true }
    }
    const accountId = await ownedTarget(connection, command, true)
    if (accountId !== candidate) throw new TradingAccessError('revision_conflict', 409)
    if (!accountId) {
      if (command.action === 'select_account') throw new TradingAccessError('trading_account_forbidden', 403)
      return { userId: command.userId, mode: 'blocked', accountId: null, observerChannelId: null, readOnly: true }
    }
    // findOwnedAccount uses execute only. Reuse the established ownership, live-route and projection checks
    // on this transaction's connection; its lease adapter reads only the captured in-memory route.
    const reader = new MysqlTradingRepository(connection as unknown as Pool, frozenLeases, observer)
    const account = await reader.findOwnedAccount(command.userId, accountId)
    if (!account) throw new TradingAccessError('trading_account_forbidden', 403)
    return { userId: command.userId, mode: 'full', accountId, observerChannelId: null, readOnly: !account.tradePermission }
  }
}
