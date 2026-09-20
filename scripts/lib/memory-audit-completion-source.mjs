import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { sha256, splitSqlStatements } from './v4-migration-plan.mjs'
export async function loadMemoryAuditCompletionSource(root) {
  const path = 'server/db/migrations/inplace/078_strategy_memory_runtime_audit_completion.sql', bytes = await readFile(new URL(path, root))
  const statements = splitSqlStatements(bytes.toString('utf8'))
  assert.equal(statements.length, 1)
  return { sources: [{ path, sha256: sha256(bytes) }], statements }
}
