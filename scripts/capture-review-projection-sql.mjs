import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { MysqlReviewRepository } from '../server/dist-v4/modules/reviews/infrastructure/mysql-review-repository.js'

const sha = value => createHash('sha256').update(value).digest('hex')
const queries = [], stop = new Error('capture_complete')
async function capture(name, matches, work) {
  const connection = { beginTransaction: async () => {}, rollback: async () => {}, commit: async () => {}, release() {},
    execute: async (sql, parameters) => {
      if (!sql.startsWith('SELECT ')) throw new Error('capture_mutation_forbidden')
      if (matches(sql)) { queries.push({ name, sql, sqlSha256: sha(sql), parameters }); throw stop }
      return [[]]
    } }
  const repository = new MysqlReviewRepository({ ...connection, getConnection: async () => connection })
  try { await work(repository); throw new Error('capture_query_missing') } catch (error) { if (error !== stop) throw error }
}
const id = '00000000-0000-4000-8000-000000000000'
await capture('review_cases', () => true, r => r.listCases(1, { limit: 10 }))
await capture('manual_candidates', () => true, r => r.listManualCandidates(1, '1', 10))
await capture('manual_selection_lock', sql => sql.includes('FROM manual_review_candidates_v4'), r => r.createManualCase({ userId: 1, candidateIds: [id], idempotencyKey: id }))
await capture('memory_updates', () => true, r => r.listMemoryUpdates(1, id))
await capture('memory_decision_lock', () => true, r => r.decideMemoryUpdate({ userId: 1, updateId: id }))
await capture('review_case_lock', () => true, r => r.returnCase({ userId: 1, caseId: id }))
const source = await readFile(new URL('../server/src/modules/reviews/infrastructure/mysql-review-repository.ts', import.meta.url))
const output = { kind: 'review-projection-selects/v2', sourceSha256: sha(source), queries }
await writeFile(new URL('../docs/migration/review-projection-sql-input-v2-20260907.json', import.meta.url), JSON.stringify(output, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ queries: queries.length }))
