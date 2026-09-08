import type { PoolConnection, RowDataPacket } from 'mysql2/promise'
import { assertMysqlAccountPrincipalReadSchema } from './mysql-account-principal-schema.js'

// v2 includes the identity revision used to invalidate observer authorization.
// v1 remains available to reproduce its historical acceptance evidence.
export async function assertMysqlAccountPrincipalReadSchemaV2(connection: Pick<PoolConnection, 'query'>): Promise<void> {
  await assertMysqlAccountPrincipalReadSchema(connection)
  try {
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT COLUMN_TYPE type,IS_NULLABLE nullable,COLLATION_NAME collationName
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users'
       AND COLUMN_NAME='token_version'`)
    if (rows.length !== 1 || rows[0]?.type !== 'int' || rows[0]?.nullable !== 'NO'
      || rows[0]?.collationName !== null) throw Error('identity_revision')
  } catch { throw Error('auth_account_principal_schema_not_ready') }
}
