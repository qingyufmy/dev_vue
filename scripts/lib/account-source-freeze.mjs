const sources = Object.freeze(['bridge_v3_terminal_sessions', 'mt5_account_bindings', 'mt5_account_ownership_history', 'trading_accounts', 'users'])
const check = (value, code) => { if (!value) throw Error(`account_source_freeze_${code}`) }
const quote = name => { check(/^[a-z][a-z0-9_]*$/.test(name), 'identifier'); return `\`${name}\`` }

// Full ordered PK scans at REPEATABLE READ hold shared record/next-key locks.
// This freezes source edits/inserts while permitting FK reads by build writers.
// The caller owns this dedicated connection; never use it for target writes.
export async function withAccountSourceFreeze(connection, database, work) {
  check(database === 'dev_vue' || /^dev_vue_lock_probe_[a-f0-9]{12}$/.test(database), 'database')
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,CONNECTION_ID() connectionId')
  check(identity.db === database && identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'identity')
  const [metadata] = await connection.query("SELECT TABLE_NAME tableName,COLUMN_NAME columnName,SEQ_IN_INDEX ordinalPosition FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND INDEX_NAME='PRIMARY' ORDER BY TABLE_NAME,SEQ_IN_INDEX")
  const keys = sources.map(table => ({ table, columns: metadata.filter(row => row.tableName === table).map(row => row.columnName) }))
  check(keys.every(key => key.columns.length > 0), 'primary_key_required')
  await connection.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ')
  await connection.query('SET SESSION innodb_lock_wait_timeout=5')
  await connection.beginTransaction()
  let active = true
  try {
    const locked = []
    for (const { table, columns } of keys) {
      const pk = columns.map(quote).join(',')
      const [rows] = await connection.query(`SELECT ${pk} FROM ${quote(table)} ORDER BY ${pk} FOR SHARE`)
      locked.push({ table, rows: rows.length, primary: columns })
    }
    const assertHeld = async () => {
      check(active, 'released')
      const [[row]] = await connection.execute("SELECT COUNT(*) n FROM information_schema.INNODB_TRX WHERE trx_mysql_thread_id=? AND trx_state='RUNNING'", [identity.connectionId])
      check(Number(row.n) === 1, 'transaction_lost')
    }
    await assertHeld()
    return await work({ locked, assertHeld })
  } finally {
    active = false
    try { await connection.rollback() } catch { connection.destroy(); throw Error('account_source_freeze_release_failed') }
  }
}
