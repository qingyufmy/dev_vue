import { plannedColumns, digest } from './v4-upgrade-review.mjs'

const names = text => text.split(',').map(value => value.trim().replaceAll('`', ''))
function columnType(declaration) {
  const match = /^(bigint|int|smallint|tinyint|mediumint|char|varchar|binary|varbinary|decimal|enum|datetime|timestamp|date)(\([^)]*\))?(\s+unsigned)?(?=\s|$)/i.exec(declaration)
  if (!match) return null
  const integer = /^(bigint|int|smallint|tinyint|mediumint)$/i.test(match[1])
  return match[1].toLowerCase() + (integer ? '' : match[2] ?? '') + (match[3] ?? '').toLowerCase()
}

// Dependency/type review only. Never execute a filtered subset of installation SQL.
export function reviewTableDependencies(plan, source) {
  const catalog = plannedColumns(plan)
  const existing = new Set(source.tables.map(table => table.table_name))
  const tables = new Map(Object.keys(catalog).filter(name => !existing.has(name)).map(name => [name, {
    name, statements: [], foreignKeys: [], blockers: [], status: 'candidate',
  }]))
  for (const migration of plan) for (const [index, sql] of migration.statements.entries()) {
    const name = /^(?:CREATE TABLE(?: IF NOT EXISTS)?|ALTER TABLE)\s+`?(\w+)`?/i.exec(sql)?.[1]
    if (!tables.has(name)) continue
    const table = tables.get(name)
    table.statements.push({ migration: migration.id, checksum: migration.checksum, statementIndex: index, sqlSha256: digest(sql) })
    for (const match of sql.matchAll(/DROP FOREIGN KEY\s+`?(\w+)`?/gi)) table.foreignKeys = table.foreignKeys.filter(key => key.name !== match[1])
    const matches = [...sql.matchAll(/CONSTRAINT\s+`?(\w+)`?\s+FOREIGN KEY\s*\(([^)]+)\)\s+REFERENCES\s+`?(\w+)`?\s*\(([^)]+)\)/gi)]
    if (matches.length !== [...sql.matchAll(/FOREIGN KEY\s*\(/gi)].length) throw new Error('inplace_dependency_fk_unparsed')
    for (const match of matches) table.foreignKeys.push({ name: match[1], columns: names(match[2]), parent: match[3], parentColumns: names(match[4]), phase: /^CREATE/i.test(sql) ? 'create' : 'alter' })
  }
  for (const table of tables.values()) for (const fk of table.foreignKeys) {
    if (fk.columns.length !== fk.parentColumns.length) throw new Error('inplace_dependency_fk_arity')
    for (let index = 0; index < fk.columns.length; index++) {
      const child = catalog[table.name]?.[fk.columns[index]]
      const parentColumn = fk.parentColumns[index]
      const old = source.columns.find(column => column.table_name === fk.parent && column.column_name === parentColumn)
      const planned = catalog[fk.parent]?.[parentColumn]
      const actualType = existing.has(fk.parent) ? old?.column_type : planned && columnType(planned.declaration)
      const expectedType = child && columnType(child.declaration)
      const textKey = /^(?:(?:var)?char|enum)\(/.test(expectedType ?? '')
      const expectedCollation = textKey ? child && (/COLLATE\s+(\w+)/i.exec(child.declaration)?.[1] ?? child.tableDefaults.collation) : null
      const parentCollation = textKey ? (existing.has(fk.parent) ? old?.collation : planned && (/COLLATE\s+(\w+)/i.exec(planned.declaration)?.[1] ?? planned.tableDefaults.collation)) : null
      let code = null
      if (!actualType || !expectedType) code = 'referenced_column_missing_or_unsupported'
      else if (columnType(actualType) !== expectedType) code = 'foreign_key_type_mismatch'
      else if (textKey && expectedCollation !== parentCollation) code = 'foreign_key_collation_mismatch'
      if (code) table.blockers.push({ code, constraint: fk.name, column: fk.columns[index], parent: `${fk.parent}.${parentColumn}`,
        expectedType, actualType: actualType ?? null, expectedCollation, parentCollation: parentCollation ?? null })
    }
  }
  let changed = true
  while (changed) {
    changed = false
    for (const table of tables.values()) {
      if (table.status === 'blocked') continue
      const parent = table.foreignKeys.find(key => key.parent !== table.name && tables.get(key.parent)?.status === 'blocked')
      if (parent) table.blockers.push({ code: 'blocked_parent', parent: parent.parent })
      if (table.blockers.length) { table.status = 'blocked'; changed = true }
    }
  }
  const order = [], remaining = new Set([...tables.values()].filter(table => table.status === 'candidate').map(table => table.name))
  while (remaining.size) {
    const available = [...remaining].filter(name => tables.get(name).foreignKeys.every(key => key.phase === 'alter' || key.parent === name || !remaining.has(key.parent)))
    if (!available.length) break
    for (const name of available.sort()) { order.push(name); remaining.delete(name) }
  }
  for (const name of remaining) { tables.get(name).status = 'blocked'; tables.get(name).blockers.push({ code: 'dependency_cycle' }) }
  return { version: 1, executable: false, sourceFingerprint: digest(source), planFingerprint: digest(plan),
    scope: 'foreign_key_column_compatibility_only', remainingChecks: ['parent_unique_keys', 'check_constraints', 'data_initializers', 'migration_corrections', 'business_mapping', 'live_rehearsal'],
    summary: { newTables: tables.size, candidates: order.length, blocked: tables.size - order.length }, candidateOrder: order, tables: [...tables.values()] }
}
