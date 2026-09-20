import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { sha256, splitSqlStatements } from './v4-migration-plan.mjs'

export async function loadReviewHistorySource(root) {
  const sources = [], statements = []
  for (const path of ['server/db/migrations/inplace/069_review_trade_kind.sql', 'server/db/migrations/inplace/070_review_legacy_conclusion.sql']) {
    const bytes = await readFile(new URL(path, root)), sql = splitSqlStatements(bytes.toString('utf8'))
    assert.equal(sql.length, 1)
    sources.push({ path, sha256: sha256(bytes) }); statements.push(...sql)
  }
  assert.match(statements[0], /^ALTER TABLE review_cases_v4\s+MODIFY COLUMN kind /)
  assert.match(statements[1], /^ALTER TABLE review_versions_v4\s+MODIFY COLUMN conclusion_code /)
  return { sources, statements }
}
