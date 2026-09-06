const table = 'database_upgrade_steps_v4'
export function mysqlColumnStore(connection, hasJournal) {
  return {
    async journal(id) {
      if (!hasJournal) return null
      const [rows] = await connection.execute(`SELECT checksum_sha256 checksum,status FROM ${table} WHERE id=?`, [id])
      return rows[0] ?? null
    },
    async column(tableName, columnName) {
      const [rows] = await connection.execute(`SELECT COLUMN_TYPE type,IS_NULLABLE nullable,COLUMN_DEFAULT defaultValue,COLLATION_NAME collation,EXTRA extra
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?`, [tableName, columnName])
      if (!rows.length) return null
      const row = rows[0]
      return { ...row, defaultValue: row.defaultValue === null ? null : String(row.defaultValue) }
    },
    async begin(step) {
      await connection.execute(`INSERT INTO ${table} (id,checksum_sha256,status,started_at_utc) VALUES (?,?,'started',UTC_TIMESTAMP(3))`, [step.id, step.checksum])
    },
    async execute(sql) { await connection.query(sql) },
    async complete(step) {
      const [result] = await connection.execute(`UPDATE ${table} SET status='completed',completed_at_utc=UTC_TIMESTAMP(3) WHERE id=? AND checksum_sha256=? AND status='started'`, [step.id, step.checksum])
      if (result.affectedRows !== 1) throw new Error('inplace_journal_completion_conflict')
    },
  }
}

export async function verifyInplaceJournal(connection) {
  const [rows] = await connection.query(`SELECT COLUMN_NAME name,COLUMN_TYPE type,IS_NULLABLE nullable,COLUMN_KEY column_key
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='database_upgrade_steps_v4' ORDER BY ORDINAL_POSITION`)
  if (!rows.length) return false
  const expected = [['id', 'varchar(191)', 'NO', 'PRI'], ['checksum_sha256', 'char(64)', 'NO', ''],
    ['status', "enum('started','completed')", 'NO', ''], ['started_at_utc', 'datetime(3)', 'NO', ''], ['completed_at_utc', 'datetime(3)', 'YES', '']]
  if (JSON.stringify(rows.map(row => [row.name, row.type, row.nullable, row.column_key])) !== JSON.stringify(expected)) throw new Error('inplace_journal_schema_conflict')
  return true
}
