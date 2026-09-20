import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { sha256, splitSqlStatements } from './v4-migration-plan.mjs'
export async function loadReviewArchiveSource(root) {
  const path = 'server/db/migrations/inplace/071_review_archived_case.sql', bytes = await readFile(new URL(path, root))
  const statements = splitSqlStatements(bytes.toString('utf8'))
  assert.equal(statements.length, 3)
  return { sources: [{ path, sha256: sha256(bytes) }], statements }
}
