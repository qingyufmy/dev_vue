import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import type { AccountPrincipalFacts, AccountPrincipalReader } from '../application/account-principal-reader.js'
import { principalStorageError } from './mysql-principal-error.js'

export function createMysqlAccountPrincipalReader(connection: Pick<PoolConnection, 'execute'>): AccountPrincipalReader {
  return {
    async readMany(userIds, lock) {
      if (!Array.isArray(userIds) || userIds.length > 101 || userIds.some(id => !Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647)
        || (lock !== 'none' && lock !== 'share')) throw Error('auth_principal_query_invalid')
      const ids = [...new Set(userIds)].sort((a, b) => a - b)
      if (!ids.length) return new Map()
      try {
        const [rows] = await connection.execute<RowDataPacket[]>(`SELECT id,plan,
          CASE WHEN plan_expires_at IS NULL THEN NULL ELSE CONCAT(LEFT(DATE_FORMAT(plan_expires_at,'%Y-%m-%dT%H:%i:%s.%f'),23),'Z') END plan_expires_at_utc,
          CAST(token_version AS CHAR) token_version
          FROM users WHERE id IN (${ids.map(() => '?').join(',')})
          AND deletion_status='active' AND deleted_at IS NULL ORDER BY id${lock === 'share' ? ' FOR SHARE' : ''}`, ids)
        const result = new Map<number, AccountPrincipalFacts>()
        for (const row of rows) {
          const id = row.id
          const expiry = row.plan_expires_at_utc
          if (!Number.isSafeInteger(id) || !ids.includes(id) || result.has(id)
            || typeof row.plan !== 'string' || row.plan.length === 0 || row.plan.length > 20
            || typeof row.token_version !== 'string' || !/^(0|[1-9][0-9]*)$/.test(row.token_version)
            || !Number.isSafeInteger(Number(row.token_version)) || Number(row.token_version) > 2_147_483_647
            || (expiry !== null && (typeof expiry !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(expiry)
              || new Date(expiry).toISOString() !== expiry))) throw Error('principal_facts')
          result.set(id, Object.freeze({ userId: id, plan: row.plan, planExpiresAtUtc: expiry, tokenVersion: Number(row.token_version) }))
        }
        return result
      } catch (error) { throw principalStorageError(error) }
    },
  }
}
