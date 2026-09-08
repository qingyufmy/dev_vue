import { legacyCandleRenames, candleTableDefinition } from './legacy-candle-promotion.mjs'

const physicalNames = new Map(legacyCandleRenames)
const logicalNames = new Map(legacyCandleRenames.map(([a, b]) => [b, a]))
const physical = name => physicalNames.get(name) ?? name
const normalize = sql => typeof sql === 'string' ? sql.replace(/\s+/g, ' ').trim() : ''
const blocked = () => { throw Error('legacy_candle_historical_query_not_allowed') }
const listQuery = 'SELECT TABLE_NAME name,TABLE_TYPE kind FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()'
const tableQuery = 'SELECT TABLE_TYPE type FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?'
const triggerQuery = 'SELECT TRIGGER_NAME name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?'
const columnQuery = 'SELECT COLUMN_TYPE type,IS_NULLABLE nullable,COLUMN_DEFAULT defaultValue,COLLATION_NAME collation,EXTRA extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?'

export function historicalCandleDefinition(logicalName, ddl) {
  if (typeof ddl !== 'string' || /^CREATE TABLE `([a-z][a-z0-9_]*)` \(/.exec(ddl)?.[1] !== physical(logicalName)) throw Error('legacy_candle_historical_definition_table')
  return candleTableDefinition(ddl, logicalNames)
}

// Use only after the promotion coordinator proves the exact promoted layout.
// This connection can be composed beneath the existing account-root metadata
// adapter. It never exposes business SELECTs, DDL, journal writes or parameters.
export function promotedCandleMetadataConnection(connection) {
  return Object.freeze({
    async query(sql) {
      const text = normalize(sql)
      if (text === 'SELECT DATABASE() db') return connection.query(text)
      if (text === listQuery) {
        const [rows, fields] = await connection.query(text)
        const tables = new Map(rows.map(row => [row.name, row.kind]))
        if (tables.get('market_candles') !== 'BASE TABLE' || tables.get('market_candles_legacy_v3') !== 'BASE TABLE'
          || tables.has('market_candles_build_v4') || tables.size !== rows.length) throw Error('legacy_candle_historical_layout')
        return [rows.map(row => ({ ...row, name: logicalNames.get(row.name) ?? row.name })), fields]
      }
      const match = /^SHOW CREATE TABLE (?:`([a-z][a-z0-9_]*)`|([a-z][a-z0-9_]*))$/.exec(text)
      if (!match) return blocked()
      const name = match[1] ?? match[2]
      const [rows, fields] = await connection.query('SHOW CREATE TABLE `' + physical(name) + '`')
      if (rows.length !== 1) throw Error('legacy_candle_historical_definition_missing')
      return [[{ ...rows[0], Table: name, 'Create Table': historicalCandleDefinition(name, rows[0]['Create Table']) }], fields]
    },
    async execute(sql, values) {
      const text = normalize(sql), count = text === columnQuery ? 2 : [tableQuery, triggerQuery].includes(text) ? 1 : 0
      if (!count || !Array.isArray(values) || values.length !== count || values.some(value => typeof value !== 'string' || !/^[a-z][a-z0-9_]*$/.test(value))) return blocked()
      return connection.execute(text, [physical(values[0]), ...values.slice(1)])
    },
  })
}
