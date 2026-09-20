import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'
import { riskStructureTables } from './risk-structure-source.mjs'

export async function readRiskStructureTable(connection, table) {
  if (!riskStructureTables.includes(table)) throw Error('risk_structure_table_outside_scope')
  const [objects] = await connection.execute(`SELECT TABLE_TYPE kind,ENGINE engine FROM information_schema.TABLES
    WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?`, [table])
  if (objects.length === 0) return null
  if (objects.length !== 1 || objects[0].kind !== 'BASE TABLE' || objects[0].engine !== 'InnoDB') throw Error('risk_structure_table_kind')
  const [[row]] = await connection.query(`SHOW CREATE TABLE \`${table}\``)
  const ddl = row?.['Create Table']
  if (typeof ddl !== 'string' || !ddl.startsWith(`CREATE TABLE \`${table}\` (`)) throw Error('risk_structure_definition_invalid')
  const [triggers] = await connection.execute(`SELECT TRIGGER_NAME name FROM information_schema.TRIGGERS
    WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?`, [table])
  if (triggers.length) throw Error('risk_structure_unexpected_trigger')
  const [[count]] = await connection.query(`SELECT CAST(COUNT(*) AS CHAR) n FROM \`${table}\``)
  if (!/^(0|[1-9][0-9]*)$/.test(count?.n ?? '') || !Number.isSafeInteger(Number(count.n))) throw Error('risk_structure_row_count_invalid')
  return { hash: tableDefinitionHash(ddl), rows: Number(count.n), ddl }
}
