import { fileURLToPath } from 'node:url'
import { loadMigrationPlan, sha256 } from './v4-migration-plan.mjs'

export const independentTables = Object.freeze(['ai_manual_analysis_cooldowns', 'outbox_events', 'global_risk_controls',
  'strategy_memory_libraries_v4', 'strategy_memory_library_revisions_v4', 'strategy_memory_injection_logs_v4',
  'trade_history_migration_checkpoints_v4', 'observer_management_registry', 'observer_management_operations', 'bridge_v4_pairing_requests'])

// Explicit reviewed scope, not the output of an automatic candidate filter.
export async function independentStructureSource(root) {
  const statements = []
  for (const migration of await loadMigrationPlan({ rootDirectory: fileURLToPath(root) })) {
    for (const sql of migration.statements) {
      const match = /^(CREATE TABLE(?: IF NOT EXISTS)?|ALTER TABLE)\s+`?([a-z][a-z0-9_]*)`?\s/i.exec(sql)
      if (!match || !independentTables.includes(match[2])) continue
      const table = match[2]
      const normalized = sql.replace(/^CREATE TABLE(?: IF NOT EXISTS)?\s+`?[a-z][a-z0-9_]*`?/, `CREATE TABLE \`${table}\``)
        .replace(/^ALTER TABLE\s+`?[a-z][a-z0-9_]*`?/, `ALTER TABLE \`${table}\``)
      statements.push({ table, sql: normalized, source: migration.file, sourceSha256: migration.checksum, statementSha256: sha256(sql) })
    }
  }
  if (statements.length !== 11 || JSON.stringify(statements.filter(row => row.sql.startsWith('CREATE')).map(row => row.table)) !== JSON.stringify(independentTables)
    || statements.filter(row => row.sql.startsWith('ALTER')).length !== 1
    || statements.find(row => row.sql.startsWith('ALTER')).sql !== 'ALTER TABLE `strategy_memory_libraries_v4`\n  ADD CONSTRAINT fk_strategy_memory_current_revision FOREIGN KEY (current_revision_id, id) REFERENCES strategy_memory_library_revisions_v4 (id, library_id)') throw Error('independent_structure_source_scope')
  return statements
}
