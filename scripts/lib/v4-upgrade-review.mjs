import { createHash } from 'node:crypto'
import { validateFieldManifest } from './v4-field-manifest.mjs'

export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const types = '(?:BIGINT|SMALLINT|TINYINT|MEDIUMINT|INT|INTEGER|VARCHAR|CHAR|LONGTEXT|MEDIUMTEXT|TEXT|JSON|DECIMAL|DOUBLE|FLOAT|DATETIME|TIMESTAMP|DATE|TIME|ENUM|BINARY|VARBINARY|BLOB|LONGBLOB|BOOLEAN)'

// Source-plan lookup only, not a SQL executor or a live-schema compatibility proof.
export function plannedColumns(plan) {
  const tables = {}
  const defaults = {}
  for (const migration of plan) for (const statement of migration.statements) {
    const create = /^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?`?(\w+)`?\s*\(/i.exec(statement)
    const alter = /^ALTER TABLE\s+`?(\w+)`?/i.exec(statement)
    if (!create && !alter) continue
    const name = (create ?? alter)[1]
    if (create) {
      if (tables[name]) throw new Error('upgrade_duplicate_create')
      tables[name] = {}
      defaults[name] = { charset: /DEFAULT CHARSET=(\w+)/i.exec(statement)?.[1] ?? null, collation: /\)\s*ENGINE=[^;]*\bCOLLATE=(\w+)/i.exec(statement)?.[1] ?? null }
    }
    if (!tables[name]) throw new Error('upgrade_alter_without_create:' + name)
    if (alter && /\b(?:CHANGE|RENAME)\s+/i.test(statement)) throw new Error('upgrade_unsupported_column_change')
    const pattern = create
      ? new RegExp('^\\s*`?(\\w+)`?\\s+(' + types + '\\b[^\\n]*)', 'gmi')
      : new RegExp('\\b(ADD|MODIFY) COLUMN\\s+`?(\\w+)`?\\s+(' + types + '\\b[^\\n]*)', 'gi')
    let matched = 0
    for (const match of statement.matchAll(pattern)) {
      const column = match[create ? 1 : 2]
      const declaration = match[create ? 2 : 3].trim().replace(/,$/, '')
      if (create || match[1].toUpperCase() === 'ADD') {
        if (tables[name][column]) throw new Error('upgrade_duplicate_column')
      } else if (!tables[name][column]) throw new Error('upgrade_modify_missing_column')
      tables[name][column] = { declaration, tableDefaults: defaults[name], migration: migration.file, checksum: migration.checksum }
      matched++
    }
    if (create && !matched) throw new Error('upgrade_empty_create')
    if (alter && [...statement.matchAll(/\b(?:ADD|MODIFY) COLUMN\b/gi)].length !== matched) throw new Error('upgrade_unsupported_column_type')
    if (alter) for (const drop of statement.matchAll(/\bDROP COLUMN\s+`?(\w+)`?/gi)) {
      if (!tables[name][drop[1]]) throw new Error('upgrade_drop_missing_column')
      delete tables[name][drop[1]]
    }
  }
  return tables
}

export function matrixRows(markdown) {
  let domain = ''
  const rows = new Map()
  for (const line of markdown.split(/\r?\n/)) {
    if (/^## /.test(line)) domain = line.slice(3)
    const cells = line.split('|').map(cell => cell.trim())
    const source = /^`(\w+)`$/.exec(cells[1] ?? '')?.[1]
    if (!source || !/^\d[\d,]*$/.test(cells[2] ?? '') || !['保留', '重塑', '拆分', '合并', '归档', '候选删除'].includes(cells[3])) continue
    const row = { domain, action: cells[3], candidateTargets: [...cells[4].matchAll(/`(\w+)`/g)].map(m => m[1]), rule: cells[5] }
    if (rows.has(source)) {
      // The matrix intentionally cross-references this execution-owned table in risk.
      if (source !== 'risk_reservations') throw new Error('upgrade_matrix_duplicate:' + source)
      if (domain.startsWith('10.')) rows.set(source, row)
    } else rows.set(source, row)
  }
  return rows
}

export function validateUpgradeReview(bundle, inventory, observation, catalog) {
  const errors = []
  const fail = (code, path) => errors.push({ code, path })
  try {
    if (bundle.executable !== false) fail('upgrade_executable_forbidden', 'executable')
    const manifestResult = validateFieldManifest(bundle.identity, inventory)
    errors.push(...manifestResult.errors)
    const expectedTables = new Set(inventory.source_tables.map(t => t.name))
    const seen = new Set()
    for (const table of bundle.coverage) {
      if (seen.has(table.sourceTable)) fail('upgrade_table_duplicate', table.sourceTable)
      seen.add(table.sourceTable)
      if (!expectedTables.has(table.sourceTable)) fail('upgrade_table_unknown', table.sourceTable)
      const source = inventory.source_tables.find(t => t.name === table.sourceTable)
      if (!source || digest(table.sourceColumns) !== digest(source.columns)) fail('upgrade_source_columns_drift', table.sourceTable)
      if (!table.domain || !table.action || !table.rule || !table.blockers.length) fail('upgrade_coverage_incomplete', table.sourceTable)
      if (table.status !== 'blocked') fail('upgrade_coverage_readiness_unproven', table.sourceTable)
      for (const target of table.targets) if (target.existsInPlan !== Boolean(catalog[target.name])) fail('upgrade_target_table_drift', target.name)
    }
    if (seen.size !== expectedTables.size || [...expectedTables].some(t => !seen.has(t))) fail('upgrade_table_missing', 'coverage')
    for (const table of bundle.identity.tables) {
      const source = observation.source[table.sourceTable]
      if (!source || digest(table.sourcePrimaryKey) !== digest(source.indexes.filter(i => i[0] === 'PRIMARY').map(i => i[3]))) fail('upgrade_primary_key_drift', table.sourceTable)
      for (const field of table.fields) {
        const path = table.sourceTable + '.' + field.sourceColumn
        const observed = source?.columns.find(c => c.name === field.sourceColumn)
        const expectedDefault = observed?.default === null ? { kind: 'null' } : { kind: observed?.extra.includes('DEFAULT_GENERATED') ? 'expression' : 'literal', value: observed?.default }
        if (!observed || field.sourceType !== observed.type || field.sourceNullable !== (observed.nullable === 'YES') || field.sourceCollation !== observed.collation || digest(field.sourceDefault) !== digest(expectedDefault)) fail('upgrade_source_field_drift', path)
        if (!field.review || !field.review.remainingChecks.length) fail('upgrade_field_review_missing', path)
        if (field.target && !/^(proposal|history-proposal|encrypted-snapshot):/.test(field.target)) {
          const [name, column, extra] = field.target.split('.')
          const planned = catalog[name]?.[column]
          if (!planned || extra) fail('upgrade_target_column_missing', path)
          else if (digest(field.review.targetDeclaration) !== digest(planned)) fail('upgrade_target_declaration_drift', path)
        }
        if (/^datetime/i.test(field.sourceType) && (!field.blockers.includes('G-TIME') || field.timeKind !== 'unknown')) fail('upgrade_time_evidence_required', path)
      }
    }
    for (const transform of bundle.identity.transforms) if (transform.specSha256 !== digest({ id: transform.id, version: transform.version, rule: transform.rule })) fail('upgrade_transform_hash_mismatch', transform.id)
    if (digest(bundle.identity.source) !== digest(bundle.frozenSource)) fail('upgrade_snapshot_mismatch', 'source')
    if (bundle.identity.source.snapshotId !== observation.provenance.sourceSnapshotId || bundle.identity.source.mirrorDatabase !== observation.sourceDatabase || bundle.identity.source.serverUuid !== observation.serverUuid) fail('upgrade_snapshot_observation_mismatch', 'source')
  } catch { fail('upgrade_review_unreadable', '') }
  return { ok: errors.length === 0, errors }
}
