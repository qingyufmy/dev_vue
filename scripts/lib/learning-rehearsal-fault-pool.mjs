// Deliberate lost acknowledgement after a real batch COMMIT, confined to the
// previously restored development copy. No ordinary command uses this wrapper.
export function learningRehearsalFaultPool(pool) {
  let injected = false
  return { get injected() { return injected }, async getConnection() {
    const connection = await pool.getConnection()
    try {
      const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
      if (identity.db !== 'dev_vue_m1_source_20260907_02' || identity.uuid !== 'ac423207-6ef3-11f1-b302-000c29fda104') throw Error('learning_rehearsal_fault_scope')
    } catch (error) { connection.destroy(); throw error }
    let batchWritten = false
    return new Proxy(connection, { get(target, key) {
      if (key === 'execute') return async (sql, parameters) => {
        const result = await target.execute(sql, parameters)
        if (/^INSERT INTO data_migration_batches\b/.test(sql)) batchWritten = true
        return result
      }
      if (key === 'commit') return async () => {
        await target.commit()
        if (batchWritten && !injected) { injected = true; throw Error('learning_rehearsal_lost_acknowledgement') }
      }
      if (key === 'rollback') return async () => { await target.rollback(); batchWritten = false }
      const value = target[key]
      return typeof value === 'function' ? value.bind(target) : value
    } })
  } }
}
