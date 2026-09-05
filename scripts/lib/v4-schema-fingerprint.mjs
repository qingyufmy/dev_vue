import { createHash } from 'node:crypto'

const hash = value => createHash('sha256').update(value).digest('hex')

// Structural parity only; this must never be presented as row, payload or financial reconciliation.
export async function readSchemaFingerprint(connection) {
  const [schemas] = await connection.query(`SELECT DEFAULT_CHARACTER_SET_NAME charset_name,
    DEFAULT_COLLATION_NAME collation_name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=DATABASE()`)
  if (schemas.length !== 1) throw new Error('schema_fingerprint_database_missing')
  const [tables] = await connection.query(`SELECT TABLE_NAME table_name,TABLE_TYPE table_type
    FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME`)
  const definitions = []
  for (const table of tables) {
    if (!/^[a-z][a-z0-9_]*$/.test(table.table_name) || table.table_type !== 'BASE TABLE') {
      throw new Error('schema_fingerprint_table_invalid')
    }
    const [rows] = await connection.query(`SHOW CREATE TABLE \`${table.table_name}\``)
    if (rows.length !== 1 || typeof rows[0]['Create Table'] !== 'string') throw new Error('schema_fingerprint_definition_missing')
    definitions.push({ name: table.table_name, ddl: rows[0]['Create Table'] })
  }
  return schemaFingerprint(schemas[0], definitions)
}

export function schemaFingerprint(schema, definitions) {
  if (!schema?.charset_name || !schema?.collation_name || !Array.isArray(definitions)) throw new Error('schema_fingerprint_input_invalid')
  const names = new Set()
  const tables = definitions.map(({ name, ddl }) => {
    if (typeof name !== 'string' || !/^[a-z][a-z0-9_]*$/.test(name) || names.has(name) || typeof ddl !== 'string' || !ddl) {
      throw new Error('schema_fingerprint_input_invalid')
    }
    names.add(name)
    // No stripping of defaults, generated expressions, collations, constraints or auto-increment state.
    return { name, sha256: hash(ddl.replace(/\r\n/g, '\n')) }
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  const charset = schema.charset_name
  const collation = schema.collation_name
  return { charset, collation, tableCount: tables.length, sha256: hash(JSON.stringify({ charset, collation, tables })), tables }
}
