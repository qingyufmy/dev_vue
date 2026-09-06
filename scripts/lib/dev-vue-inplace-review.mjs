import { digest } from './v4-upgrade-review.mjs'

export function reviewInplaceSchema(source, target) {
  if (source.database !== 'dev_vue' || !Array.isArray(source.columns) || !source.columns.length) throw new Error('inplace_source_invalid')
  const tables = new Map()
  for (const column of source.columns) {
    if (!/^[a-zA-Z0-9_]+$/.test(column.table_name) || !/^[a-zA-Z0-9_]+$/.test(column.column_name)) throw new Error('inplace_identifier_invalid')
    const columns = tables.get(column.table_name) ?? new Set()
    if (columns.has(column.column_name)) throw new Error('inplace_duplicate_column')
    columns.add(column.column_name)
    tables.set(column.table_name, columns)
  }
  if (!target || !Object.keys(target).length) throw new Error('inplace_target_invalid')
  const rows = [...new Set([...tables.keys(), ...Object.keys(target)])].sort().map(name => {
    const old = [...(tables.get(name) ?? [])].sort()
    const next = Object.keys(target[name] ?? {}).sort()
    return {
      table: name,
      category: !tables.has(name) ? 'target_only' : !target[name] ? 'source_only' : 'name_collision',
      sourceColumnCount: old.length, targetColumnCount: next.length,
      targetColumnsAbsentInSource: next.filter(column => !old.includes(column)),
      sourceColumnsAbsentInTarget: old.filter(column => !next.includes(column)),
      sharedColumnNames: old.filter(column => next.includes(column)),
      decision: !target[name] ? 'retain_until_explicit_field_disposition' : !tables.has(name) ? 'review_new_table_dependencies' : 'require_semantic_and_constraint_review',
    }
  })
  return {
    version: 1, mode: 'dev_vue_inplace_readonly_review', executable: false,
    sourceFingerprint: digest(source), targetPlanFingerprint: digest(target),
    note: 'Column-name coverage only. Shared names do not prove type, constraints, data or semantic compatibility. No executable SQL generated.',
    summary: { sourceTables: tables.size, sourceColumns: source.columns.length, targetTables: Object.keys(target).length,
      nameCollisions: rows.filter(row => row.category === 'name_collision').length,
      targetOnly: rows.filter(row => row.category === 'target_only').length,
      sourceOnly: rows.filter(row => row.category === 'source_only').length },
    tables: rows,
  }
}
