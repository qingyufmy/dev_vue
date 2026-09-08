import { readOriginalRows } from './inplace-column-evidence.mjs'
import { independentTables } from './independent-structure-plan.mjs'

export async function independentProtectedSnapshot(connection) {
  const [objects] = await connection.query('SELECT TABLE_NAME name,TABLE_TYPE type FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME')
  const definitions = [], tables = []
  for (const object of objects) {
    if (object.name === 'database_upgrade_steps_v4' || independentTables.includes(object.name)) continue
    if (object.type !== 'BASE TABLE' || !/^[a-z][a-z0-9_]*$/.test(object.name)) throw Error('independent_structure_object')
    const name = object.name
    const [[row]] = await connection.query(`SHOW CREATE TABLE \`${name}\``)
    definitions.push({ name, ddl: row['Create Table'] })
    const [columns] = await connection.execute('SELECT COLUMN_NAME name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [name])
    const [keys] = await connection.execute("SELECT COLUMN_NAME name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND INDEX_NAME='PRIMARY' ORDER BY SEQ_IN_INDEX", [name])
    if (!keys.length) throw Error('independent_structure_primary_required')
    tables.push({ name, columns: columns.map(row => row.name), primary: keys.map(row => row.name) })
  }
  return { definitions, rows: await readOriginalRows(connection, tables) }
}
