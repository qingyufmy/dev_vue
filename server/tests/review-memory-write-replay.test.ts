import { expect, it } from 'vitest'
import type { Pool } from 'mysql2/promise'
import { ReviewService } from '../src/modules/reviews/application/review-service.js'
import { MysqlReviewRepository } from '../src/modules/reviews/infrastructure/mysql-review-repository.js'

it.each(['accept', 'reject', 'revoke'] as const)('%s persists once, replays original CAS and checks library ownership', async decision => {
  let receipt: Record<string, unknown> | undefined
  let revision = 1
  let owner = true
  let writes = 0
  let libraryVersions = 0
  let outbox = 0
  const status = decision === 'accept' ? 'merged' : decision === 'reject' ? 'rejected' : 'superseded'
  const row = {
    id: 'update-1', library_id: 'library-1', source_review_case_id: 'case-1', source_review_version_id: 'version-1',
    update_kind: 'short_term', expected_library_revision: 1, proposal_json: { memory_key: 'entry', title: 'Evidence', content: 'New evidence', evidence_refs: [] },
    diff_preview_text: 'Added evidence', conflict_json: [], created_at_utc: new Date('2026-09-09T00:00:00.000Z'),
  }
  const connection = {
    beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {}, destroy: () => {},
    execute: async (sql: string, values: unknown[]) => {
      if (sql.includes('FROM users')) return [[{ id: 7 }]]
      if (sql.includes('FROM review_write_receipts_v4')) return [receipt ? [receipt] : []]
      if (sql.startsWith('SELECT u.library_id')) { expect(values).toEqual(['update-1', 7]); return [owner ? [{ library_id: 'library-1' }] : []] }
      if (sql.includes('l.owner_user_id,l.revision')) {
        expect(sql).toContain('u.merged_revision_id')
        return [[{ ...row, revision, status: decision === 'revoke' ? 'merged' : 'awaiting_confirmation', owner_user_id: 7,
          library_revision: 1, current_version_number: 1, merged_revision_id: 'prior-merge-1', content_text: 'Previous evidence',
          content_json: { schema_version: 'strategy_memory.v4.1', blocks: [{ kind: 'review_memory', memory_update_id: 'update-1', content: 'Previous evidence' }] } }]]
      }
      if (sql.includes('u.id=? AND u.library_id=? LIMIT 1')) return [[{ ...row, revision, status }]]
      if (sql.startsWith('SELECT COUNT(*)')) return [[{ pending_count: 0 }]]
      if (sql.startsWith('INSERT INTO review_write_receipts_v4')) {
        receipt = { action: values[2], request_sha256: values[3], resource_id: values[4], result_revision: String(values[5]), result_json: values[6], result_sha256: values[7] }
        return [{ affectedRows: 1 }]
      }
      if (sql.startsWith('INSERT INTO strategy_memory_library_revisions_v4')) {
        libraryVersions++
        if (decision === 'revoke') expect(JSON.parse(String(values[6]))).toMatchObject({ prior_merged_revision_id: 'prior-merge-1' })
      }
      if (sql.startsWith('INSERT INTO outbox_events')) outbox++
      if (sql.startsWith('UPDATE strategy_memory_pending_updates_v4') && sql.includes('WHERE id=?')) revision++
      writes++
      return [{ affectedRows: 1 }]
    },
  }
  const service = new ReviewService(new MysqlReviewRepository({ getConnection: async () => connection } as unknown as Pool))
  const key = 'memory-decision-0001'
  const first = await service.decideMemoryUpdate(7, 'update-1', 1, decision, key)
  expect(first).toMatchObject({ id: 'update-1', status, revision: 2 })
  const count = writes
  revision = 10
  expect(await service.decideMemoryUpdate(7, 'update-1', 1, decision, key)).toEqual(first)
  expect(libraryVersions).toBe(decision === 'reject' ? 0 : 1)
  expect(outbox).toBe(1)
  await expect(service.decideMemoryUpdate(7, 'update-1', 1, decision === 'reject' ? 'accept' : 'reject', key)).rejects.toThrow('review_idempotency_conflict')
  owner = false
  await expect(service.decideMemoryUpdate(7, 'update-1', 1, decision, key)).rejects.toThrow('strategy_memory_update_not_found')
  expect(writes).toBe(count)
})
