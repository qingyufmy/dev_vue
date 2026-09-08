import { createHash } from 'node:crypto'
import { originalCapacityDefinition } from './inplace-model-capacity-schema.mjs'

const quote = name => { if (!/^[a-z][a-z0-9_]*$/.test(name)) throw Error('model_capacity_identifier'); return `\`${name}\`` }
export async function modelCapacitySnapshot(connection, transitions) {
  const [tables] = await connection.query('SELECT TABLE_NAME name,TABLE_TYPE type FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME')
  const definitions = [], rows = []
  for (const { name, type } of tables) {
    if (name === 'database_upgrade_steps_v4') continue
    if (type !== 'BASE TABLE') throw Error('model_capacity_table_kind')
    const [[row]] = await connection.query(`SHOW CREATE TABLE ${quote(name)}`)
    definitions.push({ name, ddl: originalCapacityDefinition(name, row['Create Table'], transitions) })
    const [columns] = await connection.execute('SELECT COLUMN_NAME name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [name])
    const [keys] = await connection.execute("SELECT COLUMN_NAME name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX", [name])
    if (!keys.length) throw Error('model_capacity_primary_required')
    const numeric = new Set(transitions.filter(item => item.step.table === name && item.after.type.includes('unsigned')).map(item => item.step.column))
    const selection = columns.map(column => numeric.has(column.name) ? `CAST(${quote(column.name)} AS CHAR)` : quote(column.name)).join(',')
    const hash = createHash('sha256'); let count = 0
    const stream = connection.connection.query({ sql: `SELECT ${selection} FROM ${quote(name)} ORDER BY ${keys.map(key => quote(key.name)).join(',')}`, rowsAsArray: true }).stream({ highWaterMark: 16 })
    for await (const data of stream) { hash.update(JSON.stringify(data)); hash.update('\n'); count++ }
    rows.push({ name, rows: count, sha256: hash.digest('hex') })
  }
  return { definitions, rows }
}
