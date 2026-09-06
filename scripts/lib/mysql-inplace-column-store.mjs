const table = 'database_upgrade_steps_v4'
export function mysqlColumnStore(connection, hasJournal) {
  return {
    async history() {
      if (!hasJournal) return []
      const [rows] = await connection.query(`SELECT id,checksum_sha256 checksum,status,started_at_utc startedAt,completed_at_utc completedAt FROM ${table} ORDER BY id`)
      return rows.map(row => ({ ...row, startedAt: row.startedAt?.toISOString(), completedAt: row.completedAt?.toISOString() ?? null }))
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
  const [objects] = await connection.query(`SELECT TABLE_TYPE kind,ENGINE engine,TABLE_COLLATION collation FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='database_upgrade_steps_v4'`)
  if (!objects.length) return false
  if (objects.length !== 1 || objects[0].kind !== 'BASE TABLE' || objects[0].engine !== 'InnoDB' || objects[0].collation !== 'utf8mb4_unicode_ci') throw new Error('inplace_journal_schema_conflict')
  const [rows] = await connection.query(`SELECT COLUMN_NAME name,COLUMN_TYPE type,IS_NULLABLE nullable,COLUMN_KEY column_key,COLUMN_DEFAULT defaultValue,COLLATION_NAME collation,EXTRA extra
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='database_upgrade_steps_v4' ORDER BY ORDINAL_POSITION`)
  const expected = [['id', 'varchar(191)', 'NO', 'PRI'], ['checksum_sha256', 'char(64)', 'NO', ''],
    ['status', "enum('started','completed')", 'NO', ''], ['started_at_utc', 'datetime(3)', 'NO', ''], ['completed_at_utc', 'datetime(3)', 'YES', '']]
  if (JSON.stringify(rows.map(row => [row.name, row.type, row.nullable, row.column_key])) !== JSON.stringify(expected)) throw new Error('inplace_journal_schema_conflict')
  const collations = ['ascii_bin', 'ascii_bin', 'utf8mb4_unicode_ci', null, null]
  if (rows.some((row, index) => row.collation !== collations[index] || row.defaultValue !== null || row.extra !== '')) throw new Error('inplace_journal_schema_conflict')
  const [indexes] = await connection.query(`SELECT INDEX_NAME name,COLUMN_NAME columnName,NON_UNIQUE nonUnique,SUB_PART subPart,INDEX_TYPE type,IS_VISIBLE visible FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='database_upgrade_steps_v4'`)
  if (indexes.length !== 1 || indexes[0].name !== 'PRIMARY' || indexes[0].columnName !== 'id' || Number(indexes[0].nonUnique) !== 0 || indexes[0].subPart !== null || indexes[0].type !== 'BTREE' || indexes[0].visible !== 'YES') throw new Error('inplace_journal_schema_conflict')
  const [constraints] = await connection.query(`SELECT CONSTRAINT_TYPE type FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='database_upgrade_steps_v4'`)
  const [triggers] = await connection.query(`SELECT TRIGGER_NAME name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE='database_upgrade_steps_v4'`)
  if (constraints.length !== 1 || constraints[0].type !== 'PRIMARY KEY' || triggers.length) throw new Error('inplace_journal_schema_conflict')
  return true
}

// The connection that owns the lock must also execute every DDL and journal write.
export async function withInplaceUpgradeLock(connection, database, work) {
  if (database !== 'dev_vue') throw new Error('inplace_database_mismatch')
  const [[identity]] = await connection.query('SELECT DATABASE() db, CONNECTION_ID() id')
  if (identity.db !== database) throw new Error('inplace_database_mismatch')
  const name = 'aurum:inplace:dev_vue'
  const [[claim]] = await connection.execute('SELECT GET_LOCK(?,0) acquired', [name])
  if (Number(claim.acquired) !== 1) throw new Error('inplace_upgrade_busy')
  let primaryError
  try {
    return await work()
  } catch (error) { primaryError = error; throw error } finally {
    try {
      const [[release]] = await connection.execute('SELECT RELEASE_LOCK(?) released', [name])
      if (Number(release.released) !== 1) throw new Error('inplace_upgrade_lock_lost')
    } catch (error) { if (!primaryError) throw error }
  }
}
