import { describe, expect, it, vi } from 'vitest'
import { BackfillError } from '../scripts/lib/v4-backfill-contract.mjs'
import { MysqlBackfillRepository, readBackfillTargetIdentity } from '../scripts/lib/v4-backfill-mysql-repository.mjs'
import { loadMigrationPlan } from '../scripts/lib/v4-migration-plan.mjs'
import { resolve } from 'node:path'

function fixture() {
  const connection = { query: vi.fn(async () => [[]]), execute: vi.fn(async () => [[]]), beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), destroy: vi.fn() }
  return { connection, repo: new MysqlBackfillRepository({ getConnection: async () => connection }) }
}

describe('MySQL backfill adapter (SQL/transaction fakes only)', () => {
  it('uses the same connection, UTC and a bounded lock wait before transaction work', async () => {
    const { repo, connection: c } = fixture()
    await repo.transaction(async tx => {
      expect(tx.connection).toBe(c)
      expect(c.query.mock.calls).toEqual([["SET SESSION time_zone='+00:00'"], ['SET SESSION innodb_lock_wait_timeout=10']])
      expect(c.beginTransaction).toHaveBeenCalledOnce()
      await tx.insertRun('run', { key: 'value' }, 'hash')
    })
    expect(c.commit).toHaveBeenCalledOnce(); expect(c.rollback).not.toHaveBeenCalled(); expect(c.release).toHaveBeenCalledOnce()
    const [sql, values] = c.execute.mock.calls[0]
    expect(sql).toContain('INSERT INTO data_migration_runs')
    expect(sql).not.toContain('value'); expect(values).toEqual(['run', 'hash', '{"key":"value"}'])
  })
  it('sanitizes storage errors and only marks acknowledged deadlock rollback retryable', async () => {
    const { repo, connection: c } = fixture()
    await expect(repo.transaction(async () => { throw Object.assign(new Error('secret SQL payload'), { code: 'ER_LOCK_DEADLOCK' }) })).rejects.toMatchObject({ code: 'backfill_deadlock_rolled_back' })
    expect(c.rollback).toHaveBeenCalledOnce()
    await expect(repo.transaction(async () => { throw new Error('secret SQL payload') })).rejects.toThrow('backfill_storage_failed')
    expect(c.commit).not.toHaveBeenCalled()
  })
  it('destroys uncertain commit connections without rolling them back or releasing to pool', async () => {
    const { repo, connection: c } = fixture()
    c.commit.mockRejectedValue(new Error('connection lost'))
    await expect(repo.transaction(async () => 'result')).rejects.toMatchObject({ code: 'backfill_commit_unknown' })
    expect(c.destroy).toHaveBeenCalledOnce(); expect(c.release).not.toHaveBeenCalled(); expect(c.rollback).not.toHaveBeenCalled()
  })
  it('does not label a failed rollback as retryable', async () => {
    const { repo, connection: c } = fixture()
    c.rollback.mockRejectedValue(new Error('lost'))
    await expect(repo.transaction(async () => { throw { code: 'ER_LOCK_DEADLOCK' } })).rejects.toMatchObject({ code: 'backfill_rollback_unknown' })
    expect(c.destroy).toHaveBeenCalledOnce(); expect(c.release).not.toHaveBeenCalled()
  })
  it('reads every recovery ledger row with a current locking read', async () => {
    const { repo, connection: c } = fixture()
    await repo.transaction(async tx => {
      await tx.findRun('run')
      await tx.findBatch('run', 'batch')
      await tx.findCheckpoint('run', 'stream')
      await tx.findMapping('logical', { entityKind: 'user', sourceTable: 'users', sourcePk: [{ type: 'integer', value: '9007199254740993' }] })
      await tx.findReceipt('run', 'stream', 'pkhash')
    })
    expect(c.execute).toHaveBeenCalledTimes(5)
    for (const [sql] of c.execute.mock.calls) expect(sql).toMatch(/FOR UPDATE$/)
  })
  it('preserves bigint totals and rejects a failed checkpoint CAS', async () => {
    const { repo, connection: c } = fixture()
    c.execute.mockResolvedValueOnce([[{ sequence_number: '2', cursor_json: '[{"type":"integer","value":"9007199254740993"}]', processed_rows: '9007199254740993' }]])
    await repo.transaction(async tx => {
      const checkpoint = await tx.findCheckpoint('run', 'stream')
      expect(checkpoint.processedRows).toBe('9007199254740993')
      expect(checkpoint.cursor[0].value).toBe('9007199254740993')
    })
    c.execute.mockResolvedValueOnce([{ affectedRows: 0 }])
    await expect(repo.transaction(tx => tx.advanceCheckpoint('run', 'stream', 2, 3, [], '9007199254740994'))).rejects.toBeInstanceOf(BackfillError)
    expect(c.rollback).toHaveBeenCalledOnce()
  })
  it('fingerprints migration and correction facts and rejects incomplete schema journals', async () => {
    const c = { query: vi.fn() }
    c.query.mockResolvedValueOnce([[{ db: 'target', server_uuid: 'uuid' }]])
      .mockResolvedValueOnce([[{ id: '025', checksum_sha256: 'abc', status: 'completed', statement_count: 5, completed_statements: 5 }]])
      .mockResolvedValueOnce([[]])
    expect(await readBackfillTargetIdentity(c)).toMatchObject({ database: 'target', serverUuid: 'uuid', schemaHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
    c.query.mockResolvedValueOnce([[{ db: 'target', server_uuid: 'uuid' }]])
      .mockResolvedValueOnce([[{ id: '025', status: 'running', statement_count: 5, completed_statements: 1 }]])
    await expect(readBackfillTargetIdentity(c)).rejects.toMatchObject({ code: 'backfill_schema_not_complete' })
  })
  it('adds metadata-only migration 025 with no business seed or deletion', async () => {
    const plan = await loadMigrationPlan({ rootDirectory: resolve(import.meta.dirname, '..') })
    const migration = plan.find(m => m.id === '20260906_025_data_migration_batch_ledger')
    expect(migration.statements).toHaveLength(5)
    for (const sql of migration.statements) {
      expect(sql).toMatch(/^CREATE TABLE data_migration_/)
      expect(sql).not.toMatch(/\b(?:INSERT|DELETE|UPDATE|DROP|TRUNCATE|CASCADE)\b/)
    }
  })
})
