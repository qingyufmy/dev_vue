import type { PoolConnection, RowDataPacket } from 'mysql2/promise'

// auth/account-principal-read/v1: columns consumed by account ownership and observer reads.
// This is not readiness for every auth write or for the complete users table.
const columns = [
  { name: 'id', type: 'int', nullable: 'NO', collationName: null },
  { name: 'role', type: 'varchar(20)', nullable: 'NO', collationName: 'utf8mb4_0900_ai_ci' },
  { name: 'plan', type: 'varchar(20)', nullable: 'NO', collationName: 'utf8mb4_0900_ai_ci' },
  { name: 'plan_expires_at', type: 'datetime(3)', nullable: 'YES', collationName: null },
  { name: 'deleted_at', type: 'datetime(3)', nullable: 'YES', collationName: null },
  { name: 'deletion_status', type: 'varchar(24)', nullable: 'NO', collationName: 'utf8mb4_0900_ai_ci' },
] as const

export async function assertMysqlAccountPrincipalReadSchema(connection: Pick<PoolConnection, 'query'>): Promise<void> {
  try {
    const [tables] = await connection.query<RowDataPacket[]>(
      "SELECT TABLE_TYPE kind,ENGINE engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users'")
    if (tables.length !== 1 || tables[0]?.kind !== 'BASE TABLE' || tables[0]?.engine !== 'InnoDB') throw Error('table')
    const [actual] = await connection.query<RowDataPacket[]>(
      `SELECT COLUMN_NAME name,COLUMN_TYPE type,IS_NULLABLE nullable,COLLATION_NAME collationName
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users'
       AND COLUMN_NAME IN ('id','role','plan','plan_expires_at','deleted_at','deletion_status')`)
    if (actual.length !== columns.length || columns.some(expected => {
      const matches = actual.filter(row => row.name === expected.name)
      return matches.length !== 1 || matches[0]?.type !== expected.type || matches[0]?.nullable !== expected.nullable
        || matches[0]?.collationName !== expected.collationName
    })) throw Error('columns')
    const [keys] = await connection.query<RowDataPacket[]>(
      `SELECT COLUMN_NAME columnName,SEQ_IN_INDEX sequence,NON_UNIQUE nonUnique
       FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND INDEX_NAME='PRIMARY'`)
    if (keys.length !== 1 || keys[0]?.columnName !== 'id' || Number(keys[0]?.sequence) !== 1
      || Number(keys[0]?.nonUnique) !== 0) throw Error('key')
  } catch { throw Error('auth_account_principal_schema_not_ready') }
}
