const hidden = 'trading_context_changes_v4'
const columns = 'SELECT TABLE_NAME table_name,COLUMN_NAME column_name,COLUMN_KEY column_key,DATA_TYPE data_type,EXTRA extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,ORDINAL_POSITION'
const tables = 'SELECT TABLE_NAME name,TABLE_TYPE kind FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()'
const normalize = sql => typeof sql === 'string' ? sql.replace(/\s+/g, ' ').trim() : ''
const blocked = () => { throw Error('context_history_query_not_allowed') }

function assertRead(sql) {
  const value = normalize(sql)
  if (!/^(?:SELECT\s|SHOW CREATE TABLE\s)/.test(value) || /;|--|\/\*/.test(value)
    || /\b(?:GET_LOCK|RELEASE_LOCK|SLEEP|INTO|OUTFILE|DUMPFILE)\b|FOR UPDATE/i.test(value)
    || value.includes(hidden)) blocked()
  return value
}

// Only use after independently verifying the new table against its registered canonical schema.
// No unknown table, row, field or migration journal entry is removed here.
export function contextChangesHistoricalConnection(connection) {
  async function read(method, sql, values) {
    const text = assertRead(sql)
    if (values?.some(value => value === hidden)) blocked()
    const [rows, fields] = await connection[method](sql, values)
    if (text === columns || text === tables) {
      if (!Array.isArray(rows)) throw Error('context_history_metadata_invalid')
      const key = text === columns ? 'table_name' : 'name'
      return [rows.filter(row => row[key] !== hidden), fields]
    }
    return [rows, fields]
  }
  return Object.freeze({
    query: (sql, values) => read('query', sql, values),
    execute: (sql, values) => read('execute', sql, values),
    connection: Object.freeze({
      query(options) {
        if (!options || typeof options !== 'object' || options.rowsAsArray !== true) return blocked()
        assertRead(options.sql)
        return connection.connection.query(options)
      },
    }),
  })
}
