import { readFile } from 'node:fs/promises'
import { sha256, splitSqlStatements } from './v4-migration-plan.mjs'

const files = Object.freeze({
  '20260903_006_account_trader_worker.sql': 'eac86099de26cef5948bc71464269579b0a466f07ea37fa21dc64538baa9dda8',
  '20260903_007_deterministic_risk_review.sql': 'ed697bb67c7c87d389575f00462a961011cd45d115287cc018bf6e40fbef7d3e',
  '20260903_008_manual_risk_release.sql': 'c27c28fa6aaa1f63aadeb9b43e0858679d927f88f932050a943d2f4b07fe34c1',
})
export const riskStructureTables = Object.freeze(['risk_policy_sets_v4', 'risk_policy_versions_v4',
  'risk_policy_change_items_v4', 'account_risk_states', 'risk_state_events', 'account_risk_summaries', 'risk_manual_releases'])
const policyForeignKey = 'ALTER TABLE risk_policy_sets_v4\n  ADD CONSTRAINT fk_risk_policy_active_version\n    FOREIGN KEY (active_version_id, id) REFERENCES risk_policy_versions_v4 (id, policy_set_id)'

export async function loadRiskStructureSource(root) {
  const sources = Object.fromEntries(await Promise.all(Object.keys(files).map(async file =>
    [file, await readFile(new URL(`server/db/migrations/${file}`, root))])))
  return selectRiskStructureSource(sources)
}

// Exact immutable sources, an explicit table scope, and one reviewed cyclic FK.
// No seed, policy update, or decision-table alteration may enter this plan.
export function selectRiskStructureSource(sources) {
  if (Object.keys(sources).length !== Object.keys(files).length) throw Error('risk_structure_source_scope')
  const selected = new Map()
  let activeVersion
  for (const [file, checksum] of Object.entries(files)) {
    const raw = sources[file]
    if (!raw || sha256(raw) !== checksum) throw Error('risk_structure_source_changed')
    for (const sql of splitSqlStatements(raw.toString('utf8'))) {
      const match = /^CREATE TABLE IF NOT EXISTS ([a-z0-9_]+) \(/.exec(sql)
      if (match && riskStructureTables.includes(match[1])) {
        if (selected.has(match[1])) throw Error('risk_structure_duplicate_table')
        selected.set(match[1], { table: match[1], sql: sql.replace('CREATE TABLE IF NOT EXISTS', 'CREATE TABLE'),
          source: file, sourceSha256: checksum, statementSha256: sha256(sql) })
      } else if (sql === policyForeignKey) {
        activeVersion = { table: 'risk_policy_sets_v4', sql, source: file, sourceSha256: checksum, statementSha256: sha256(sql) }
      }
    }
  }
  if (selected.size !== riskStructureTables.length || !activeVersion) throw Error('risk_structure_incomplete')
  const statements = riskStructureTables.map(table => selected.get(table))
  statements.splice(2, 0, activeVersion)
  const available = new Set(['users', 'trading_accounts'])
  for (const statement of statements) {
    if (statement.sql.startsWith('CREATE TABLE')) available.add(statement.table)
    for (const match of statement.sql.matchAll(/REFERENCES ([a-z0-9_]+) \(/g)) {
      if (!available.has(match[1])) throw Error('risk_structure_dependency_order')
    }
  }
  return { version: 'risk-structure-source/v1', statements,
    sqlSha256: sha256(statements.map(row => row.sql + ';').join('\n\n') + '\n') }
}

/** Metadata is advisory evidence; the apply coordinator must reread under its upgrade lock. */
export function inspectRiskStructurePrerequisites(report) {
  if (report?.kind !== 'risk-upgrade-readiness/v1' || report.inspected !== true
    || !Array.isArray(report.columns) || !Array.isArray(report.keys) || !Array.isArray(report.tables)) throw Error('risk_structure_evidence_invalid')
  const issues = []
  for (const [table, type] of [['users', 'int'], ['trading_accounts', 'bigint unsigned']]) {
    const column = report.columns.find(row => row.tableName === table && row.name === 'id')
    if (!column || column.type !== type || column.nullable !== 'NO') issues.push({ table, code: 'referenced_id_type_mismatch', expected: type })
    const primary = report.keys.filter(row => row.tableName === table && row.constraintName === 'PRIMARY')
    if (primary.length !== 1 || primary[0].columnName !== 'id') issues.push({ table, code: 'referenced_id_not_primary' })
  }
  for (const table of riskStructureTables) {
    if (report.tables.some(row => row.name === table)) issues.push({ table, code: 'target_already_exists_requires_reconciliation' })
  }
  return { readyForStructurePreparation: issues.length === 0, issues, applyReady: false,
    pending: ['append-only-coordinator-registration', 'locked-live-preconditions', 'restore-proof', 'legacy-data-mapping'] }
}
