import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  requireMigration as check,
  sha256,
  splitSqlStatements,
  validateMigrationStatement,
} from './v4-migration-plan.mjs'

const CORRECTION_ID = '011-execution-intent-foreign-keys'
const MIGRATION_ID = '20260904_011_user_execution_commands_and_distributions'
const STATEMENT_NUMBER = 3
const CORRECTION_FILE = 'server/db/migrations/corrections/011-execution-intent-foreign-keys.sql'

// These bindings are deliberately file- and statement-specific. If the original
// migration or this correction changes, recovery must stop for a new review.
const ORIGINAL_CHECKSUM = '59f39b04871bee1a470785f03d3a7de1719c39a4abe22e87c16a2a8d3dc0ca3f'
const ORIGINAL_STATEMENT_CHECKSUM = 'e2d3d71be9dfd1db4703345e929eef8421e162179e8a4adabab72ee318c08250'
const CORRECTION_CHECKSUM = '747c209d9dfe75ad969cf04e4b037d7b1e1dc6838565bf63c2db20de4dea419b'
const CORRECTION_STATEMENT_CHECKSUM = 'c307519eb07ac064382c7ee372a8e63aa51b578d5589bec2b91384beca8ec7e9'

export async function loadMigrationCorrections({ rootDirectory }, plan) {
  check(typeof rootDirectory === 'string' && rootDirectory.length > 0, 'migration_correction_root_invalid')
  check(Array.isArray(plan), 'migration_correction_plan_invalid')

  const original = plan.find(migration => migration?.id === MIGRATION_ID)
  check(original, 'migration_correction_original_missing', { migrationId: MIGRATION_ID })
  check(original.checksum === ORIGINAL_CHECKSUM, 'migration_correction_original_checksum_mismatch', {
    migrationId: MIGRATION_ID,
  })
  check(Array.isArray(original.statements) && original.statements.length >= STATEMENT_NUMBER,
    'migration_correction_original_statement_missing', { migrationId: MIGRATION_ID, statementNumber: STATEMENT_NUMBER })

  const originalStatement = original.statements[STATEMENT_NUMBER - 1]
  check(typeof originalStatement === 'string', 'migration_correction_original_statement_invalid', {
    migrationId: MIGRATION_ID,
    statementNumber: STATEMENT_NUMBER,
  })
  check(sha256(originalStatement) === ORIGINAL_STATEMENT_CHECKSUM,
    'migration_correction_original_statement_checksum_mismatch', {
      migrationId: MIGRATION_ID,
      statementNumber: STATEMENT_NUMBER,
    })

  const raw = await readFile(join(rootDirectory, CORRECTION_FILE))
  const checksum = sha256(raw)
  check(checksum === CORRECTION_CHECKSUM, 'migration_correction_checksum_mismatch', { id: CORRECTION_ID })

  const statements = splitSqlStatements(raw.toString('utf8'))
  check(statements.length === 1, 'migration_correction_statement_count_invalid', { id: CORRECTION_ID })
  const sql = statements[0]
  check(sha256(sql) === CORRECTION_STATEMENT_CHECKSUM, 'migration_correction_statement_checksum_mismatch', {
    id: CORRECTION_ID,
  })
  validateMigrationStatement(sql, CORRECTION_ID)

  return Object.freeze([Object.freeze({
    id: CORRECTION_ID,
    migrationId: MIGRATION_ID,
    statementNumber: STATEMENT_NUMBER,
    originalChecksum: ORIGINAL_CHECKSUM,
    originalStatementChecksum: ORIGINAL_STATEMENT_CHECKSUM,
    checksum,
    sqlChecksum: CORRECTION_STATEMENT_CHECKSUM,
    sql,
  })])
}
