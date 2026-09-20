import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { sha256, splitSqlStatements } from './v4-migration-plan.mjs'

// Memory libraries/revisions/injection logs already have verified canonical
// structures. Admit the missing review aggregate without recreating those tables.
export async function loadReviewRuntimeSource(root) {
  const sources = []
  for (const path of ['server/db/migrations/20260904_012_review_memory_core.sql', 'server/db/migrations/inplace/049_review_write_receipts.sql']) {
    const bytes = await readFile(new URL(path, root))
    sources.push({ path, sha256: sha256(bytes), statements: splitSqlStatements(bytes.toString('utf8')) })
  }
  const existing = new Set(['strategy_memory_libraries_v4', 'strategy_memory_library_revisions_v4', 'strategy_memory_injection_logs_v4'])
  const statements = sources.flatMap(source => source.statements.filter(sql => {
    const name = /^(?:CREATE TABLE(?: IF NOT EXISTS)?|ALTER TABLE) ([a-z][a-z0-9_]*)/.exec(sql)?.[1]
    assert.ok(name)
    return !existing.has(name)
  }))
  assert.equal(statements.length, 13)
  return { sources: sources.map(({ path, sha256 }) => ({ path, sha256 })), statements }
}
