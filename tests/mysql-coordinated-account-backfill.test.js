import { describe, expect, it, vi, beforeEach } from 'vitest'
const state = vi.hoisted(() => ({ completed: true, journal: true, calls: 0 }))
vi.mock('../scripts/lib/mysql-inplace-column-store.mjs', () => ({ verifyInplaceJournal: async () => state.journal }))
vi.mock('../scripts/lib/inplace-schema-coordinator.mjs', () => ({
  loadInplaceSchemaCoordinator: async () => ({ steps: [{ id: 'all-phases', checksum: 'a'.repeat(64) }], store: c => c }),
  coordinateInplaceSchema: async () => { state.calls++; return { steps: [{ status: state.completed ? 'completed' : 'pending' }] } },
}))
import { MysqlCoordinatedAccountBackfillRepository, readCoordinatedAccountTargetIdentity } from '../scripts/lib/mysql-coordinated-account-backfill.mjs'

function fixture() {
  const connection = { query: vi.fn(async sql => sql.startsWith('SELECT DATABASE') ? [[{ db: 'dev_vue', uuid: 'fixture' }]]
    : sql.startsWith('SHOW CREATE') ? [[{ 'Create Table': `CREATE TABLE ${sql.slice(18)} (id int)` }]] : [[]]),
    beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), destroy: vi.fn() }
  return { connection, repository: new MysqlCoordinatedAccountBackfillRepository({ getConnection: async () => connection }) }
}
beforeEach(() => { state.completed = true; state.journal = true; state.calls = 0 })
describe('coordinated account transaction adapter', () => {
  it('validates the full registry on each transaction while retaining source preservation', async () => {
    const { repository } = fixture()
    expect(repository.sourceEvidence).toBe(true)
    for (let i = 0; i < 2; i++) {
      const identity = await repository.transaction(tx => tx.targetIdentity())
      expect(identity).toMatchObject({ database: 'dev_vue', storageMode: 'inplace-account-v2' })
      expect(identity.schemaHash).toMatch(/^[a-f0-9]{64}$/)
    }
    expect(state.calls).toBe(2)
  })
  it('rejects missing journal before interpreting table identity', async () => {
    state.journal = false
    await expect(readCoordinatedAccountTargetIdentity(fixture().connection)).rejects.toThrow('backfill_inplace_journal_required')
    expect(state.calls).toBe(0)
  })
  it('rolls back if later schema phases are not complete', async () => {
    state.completed = false
    const { repository, connection } = fixture()
    await expect(repository.transaction(tx => tx.targetIdentity())).rejects.toThrow('backfill_inplace_schema_not_complete')
    expect(connection.commit).not.toHaveBeenCalled(); expect(connection.rollback).toHaveBeenCalledOnce()
  })
  it('retains uncertain commit behavior without retrying writes', async () => {
    const { repository, connection } = fixture()
    connection.commit.mockRejectedValue(new Error('response lost'))
    await expect(repository.transaction(tx => tx.targetIdentity())).rejects.toThrow('backfill_commit_unknown')
    expect(connection.destroy).toHaveBeenCalledOnce(); expect(connection.release).not.toHaveBeenCalled()
  })
})
