import { randomUUID } from 'node:crypto'
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { AccountRegistration } from '../application/account-registration.js'

interface AccountRow extends RowDataPacket { id: string | number; currency: string }
interface OwnershipRow extends RowDataPacket { ownership_revision: string | number; interval_id?: string }

export class MysqlAccountRegistration implements AccountRegistration {
  constructor(private readonly connection: PoolConnection) {}

  async lockAccount(input: Parameters<AccountRegistration['lockAccount']>[0]): ReturnType<AccountRegistration['lockAccount']> {
    const [rows] = await this.connection.execute<AccountRow[]>(`SELECT CAST(a.id AS CHAR) id,a.platform,a.broker_server,a.account_login,a.currency
      FROM trading_accounts a
      WHERE a.platform=? AND BINARY a.broker_server=BINARY ? AND BINARY a.account_login=BINARY ?
        AND a.deleted_at_utc IS NULL
      LIMIT 1 FOR UPDATE`, [input.platform, input.brokerServer, input.login])
    const row = rows[0]
    return row ? { id: String(row.id), currency: row.currency } : null
  }

  async lockCurrentOwnership(input: Parameters<AccountRegistration['lockCurrentOwnership']>[0]): ReturnType<AccountRegistration['lockCurrentOwnership']> {
    const [rows] = await this.connection.execute<OwnershipRow[]>(`SELECT CAST(a.ownership_revision AS CHAR) ownership_revision,o.interval_id
      FROM trading_accounts a
      INNER JOIN trading_account_ownerships o ON o.trading_account_id=a.id AND o.user_id=?
        AND o.role='owner' AND o.revoked_at_utc IS NULL AND o.revision=a.ownership_revision
      INNER JOIN trading_account_ownership_intervals oi ON oi.id=o.interval_id
        AND oi.user_id=o.user_id AND oi.trading_account_id=o.trading_account_id AND oi.role='owner'
        AND oi.ended_at_utc IS NULL AND oi.started_at_utc=o.granted_at_utc
        AND oi.started_at_utc<=UTC_TIMESTAMP(3)
      INNER JOIN users u ON u.id=o.user_id AND u.deletion_status='active' AND u.deleted_at IS NULL
      WHERE a.id=? AND a.deleted_at_utc IS NULL
      LIMIT 1 FOR UPDATE`, [input.userId, input.accountId])
    if (rows.length !== 1) return null
    const revision = String(rows[0]!.ownership_revision)
    return /^[1-9][0-9]{0,19}$/.test(revision) ? revision : null
  }

  async createAccount(input: Parameters<AccountRegistration['createAccount']>[0]): ReturnType<AccountRegistration['createAccount']> {
    const [inserted] = await this.connection.execute<ResultSetHeader>(`INSERT INTO trading_accounts
      (platform,broker_server,account_login,currency,ownership_revision,created_at_utc,updated_at_utc,deleted_at_utc)
      VALUES (?,?,?,?,1,?,?,NULL)`, [input.platform, input.brokerServer, input.login, input.currency, input.registeredAt, input.registeredAt])
    if (inserted.affectedRows !== 1) return { ok: false, reason: 'storage_unavailable' }
    // Keep unsigned BIGINT identity out of JavaScript number conversion.
    const [rows] = await this.connection.execute<(RowDataPacket & { id: string })[]>(`SELECT CAST(LAST_INSERT_ID() AS CHAR) id`)
    const id = rows[0]?.id
    if (typeof id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(id)) return { ok: false, reason: 'storage_invalid' }
    return { ok: true, accountId: id }
  }

  async grantFirstOwnership(input: Parameters<AccountRegistration['grantFirstOwnership']>[0]): ReturnType<AccountRegistration['grantFirstOwnership']> {
    const intervalId = randomUUID()
    const [interval] = await this.connection.execute<ResultSetHeader>(`INSERT INTO trading_account_ownership_intervals
      (id,user_id,trading_account_id,role,started_at_utc,ended_at_utc,end_reason,origin_kind,origin_ref,created_at_utc,updated_at_utc)
      VALUES (?,?,?,'owner',?,NULL,NULL,'runtime',?,?,?)`,
    [intervalId, input.userId, input.accountId, input.registeredAt, `bridge-first-account:${input.accountId}`, input.registeredAt, input.registeredAt])
    if (interval.affectedRows !== 1) return { ok: false, reason: 'storage_unavailable' }
    const [owner] = await this.connection.execute<ResultSetHeader>(`INSERT INTO trading_account_ownerships
      (user_id,trading_account_id,role,granted_at_utc,revoked_at_utc,interval_id,revision)
      VALUES (?,?,'owner',?,NULL,?,1)`, [input.userId, input.accountId, input.registeredAt, intervalId])
    if (owner.affectedRows !== 1) return { ok: false, reason: 'storage_unavailable' }
    return { ok: true }
  }
}
