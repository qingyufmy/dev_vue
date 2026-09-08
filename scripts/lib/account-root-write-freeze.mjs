const check = (value, code) => { if (!value) throw Error(`account_root_freeze_${code}`) }
const quote = name => { check(typeof name === 'string' && /^[a-z][a-z0-9_]*$/.test(name), 'identifier'); return `\`${name}\`` }

// Dedicated autocommit connection only. Unlike transaction range locks, explicit
// WRITE table locks survive RENAME TABLE and journal commits on this connection.
// Freeze all existing tables so the root proof also protects non-account data.
export async function withAccountRootWriteFreeze(connection, observer, database, tables, work) {
  check(database === 'dev_vue' || /^dev_vue_ddl_probe_[a-f0-9]{12}$/.test(database), 'database')
  check(Array.isArray(tables) && tables.length > 0 && new Set(tables).size === tables.length, 'tables')
  const initial = [...tables].sort()
  initial.forEach(quote)
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid,CONNECTION_ID() connectionId,@@autocommit autoCommit')
  check(identity.db === database && identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104' && Number(identity.autoCommit) === 1, 'identity')
  const [[watcher]] = await observer.query('SELECT DATABASE() db,@@server_uuid uuid,CONNECTION_ID() connectionId')
  check(watcher.db === database && watcher.uuid === identity.uuid && String(watcher.connectionId) !== String(identity.connectionId), 'observer')
  const names = async () => {
    const [rows] = await connection.query('SELECT TABLE_NAME name,TABLE_TYPE kind,ENGINE engine FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME')
    check(rows.every(row => row.kind === 'BASE TABLE' && row.engine === 'InnoDB'), 'table_kind')
    return rows.map(row => row.name).sort()
  }
  check(JSON.stringify(await names()) === JSON.stringify(initial), 'table_set')
  await connection.query('SET SESSION lock_wait_timeout=5')
  let active = false
  try {
    await connection.query(`LOCK TABLES ${initial.map(name => `${quote(name)} WRITE`).join(',')}`)
    active = true
    const assertHeld = async (expected = initial) => {
      check(active, 'released')
      check(Array.isArray(expected) && expected.length === initial.length && new Set(expected).size === expected.length, 'expected_tables')
      expected.forEach(quote)
      const sorted = [...expected].sort()
      check(JSON.stringify(await names()) === JSON.stringify(sorted), 'table_set')
      // performance_schema tables cannot be read through the LOCK TABLES session
      // unless listed themselves. An independent observer verifies actual ownership.
      const [locks] = await observer.execute(`SELECT OBJECT_NAME name,LOCK_TYPE lockType,LOCK_DURATION duration FROM performance_schema.metadata_locks
        WHERE OBJECT_SCHEMA=? AND OBJECT_TYPE='TABLE' AND LOCK_STATUS='GRANTED'
        AND OWNER_THREAD_ID=(SELECT THREAD_ID FROM performance_schema.threads WHERE PROCESSLIST_ID=?)`, [database, identity.connectionId])
      // MySQL 8.4 reports these as TRANSACTION initially and can transfer their
      // duration during DDL. Require the owning session's actual exclusive table
      // mode, not one metadata duration label.
      if (!sorted.every(name => locks.some(lock => lock.name === name && lock.lockType === 'SHARED_NO_READ_WRITE'
        && ['TRANSACTION', 'EXPLICIT'].includes(lock.duration)))) {
        const error = Error('account_root_freeze_lock_lost'); error.lockEvidence = locks; throw error
      }
    }
    await assertHeld()
    return await work({ assertHeld })
  } finally {
    active = false
    // Also release on ambiguous LOCK acquisition; never return a pooled session.
    try { await connection.query('UNLOCK TABLES') }
    catch { connection.destroy(); throw Error('account_root_freeze_release_failed') }
  }
}
