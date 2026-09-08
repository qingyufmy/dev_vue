import { randomUUID } from 'node:crypto'
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import type { AccountRegistration } from '../application/account-registration.js'

export class MysqlAccountRegistration implements AccountRegistration {
  constructor(private readonly connection: PoolConnection) {}

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
