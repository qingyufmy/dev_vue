import assert from 'node:assert/strict'
import { readOriginalRows } from './inplace-column-evidence.mjs'
import { canonical, hash } from './v4-backfill-contract.mjs'

const quote = name => { assert.match(name, /^[a-z][a-z0-9_]*$/); return `\`${name}\`` }
export async function readAccountRootSnapshot(connection) {
  const [columns] = await connection.query('SELECT TABLE_NAME table_name,COLUMN_NAME column_name,COLUMN_KEY column_key,DATA_TYPE data_type,EXTRA extra FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME,ORDINAL_POSITION')
  const tables = new Map()
  for (const row of columns) {
    if (!tables.has(row.table_name)) tables.set(row.table_name, { name: row.table_name, columns: [], primary: [], metadata: [] })
    const table = tables.get(row.table_name)
    table.columns.push(row.column_name); table.metadata.push(row)
    if (row.column_key === 'PRI') table.primary.push(row.column_name)
  }
  const data = await readOriginalRows(connection, [...tables.values()])
  const result = []
  for (const row of data) {
    const [[definition]] = await connection.query(`SHOW CREATE TABLE ${quote(row.name)}`)
    result.push({ name: row.name, ddl: definition['Create Table'], rows: row.rows, rowsSha256: row.sha256 })
  }
  return { tables: result, metadata: tables }
}

export async function verifyAccountBusinessProjection(connection, metadata, proof) {
  for (const expected of proof.comparisons) {
    const columns = metadata.get(expected.table).metadata.filter(row => !row.extra.includes('GENERATED'))
    assert.equal(columns.length, expected.columns)
    const select = columns.map(row => {
      const name = quote(row.column_name)
      return ['int', 'bigint', 'tinyint', 'smallint'].includes(row.data_type) ? `CAST(${name} AS CHAR) ${name}`
        : row.data_type === 'datetime' ? `DATE_FORMAT(${name},'%Y-%m-%d %H:%i:%s.%f') ${name}` : name
    })
    const [actual] = await connection.query(`SELECT ${select.join(',')} FROM ${quote(expected.table)}`)
    for (const row of actual) for (const column of columns) if (column.data_type === 'datetime' && row[column.column_name] !== null) {
      assert.match(row[column.column_name], /\.\d{3}000$/); row[column.column_name] = row[column.column_name].slice(0, -3)
    }
    assert.equal(actual.length, expected.rows)
    assert.equal(hash(actual.map(row => canonical({ ...row })).sort()), expected.sha256)
  }
}
