import { riskStructureTables } from './risk-structure-source.mjs'

const hidden = new Set(riskStructureTables)
const columns = 'SELECT TABLE_NAME table_name,COLUMN_NAME column_name,COLUMN_KEY column_key,DATA_TYPE data_type,EXTRA extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,ORDINAL_POSITION'
const tables = 'SELECT TABLE_NAME name,TABLE_TYPE kind FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()'
const blocked = () => { throw Error('risk_history_query_not_allowed') }
function assertRead(sql, values) {
  if (typeof sql !== 'string') blocked()
  const text = sql.replace(/\s+/g, ' ').trim()
  if (!/^(SELECT\s|SHOW CREATE TABLE\s)/.test(text) || /;|--|\/\*/.test(text)
    || /\b(GET_LOCK|RELEASE_LOCK|SLEEP|INTO|OUTFILE|DUMPFILE)\b|FOR UPDATE/i.test(text)
    || riskStructureTables.some(table => new RegExp(`\\b${table}\\b`, 'i').test(text))
    || values?.some(value => typeof value === 'string' ? hidden.has(value.toLowerCase())
      : value !== null && typeof value !== 'number' && typeof value !== 'boolean')) blocked()
  return text
}

// Only hand this read-only view to historical validators after the new structures
// have been checked by inspectRiskStructure. Never filter the migration journal.
export function riskStructureHistoricalConnection(connection) {
  async function read(method, sql, values) {
    const text = assertRead(sql, values)
    const [rows, fields] = await connection[method](sql, values)
    if (text === columns || text === tables) {
      if (!Array.isArray(rows)) throw Error('risk_history_metadata_invalid')
      const key = text === columns ? 'table_name' : 'name'
      if (rows.some(row => typeof row[key] !== 'string')) throw Error('risk_history_metadata_invalid')
      return [rows.filter(row => !hidden.has(row[key])), fields]
    }
    return [rows, fields]
  }
  return Object.freeze({
    query: (sql, values) => read('query', sql, values),
    execute: (sql, values) => read('execute', sql, values),
    connection: Object.freeze({ query(options) {
      if (!options || typeof options !== 'object' || options.rowsAsArray !== true || options.values !== undefined) return blocked()
      assertRead(options.sql)
      return connection.connection.query(options)
    } }),
  })
}
