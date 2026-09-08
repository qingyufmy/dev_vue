import { beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ count: 147, complete: true, status: 'completed', journal: true, checksum: 'a'.repeat(64) }))
vi.mock('../scripts/lib/mysql-inplace-column-store.mjs', () => ({ verifyInplaceJournal: async () => state.journal }))
vi.mock('../scripts/lib/inplace-subscription-foreign-key-schema.mjs', () => ({
  loadSubscriptionForeignKeyCoordinator: async () => ({
    steps: Array.from({ length: state.count }, (_, i) => ({ id: `step-${i}`, checksum: state.checksum })), store: c => c,
  }),
}))
vi.mock('../scripts/lib/inplace-schema-coordinator.mjs', () => ({
  coordinateInplaceSchema: async () => ({ structureComplete: state.complete,
    steps: Array.from({ length: state.count }, () => ({ status: state.status })) }),
}))
import { readAccountBackfillV2Identity, MysqlAccountBackfillV2Repository } from '../scripts/lib/mysql-account-backfill-v2.mjs'
import { hash, inplaceAccountTargets } from '../scripts/lib/v4-backfill-contract.mjs'
import { tableDefinitionHash } from '../scripts/lib/inplace-foundation-upgrade.mjs'

function fixture() {
  const ddl = 'CREATE TABLE fixture (id int)'
  const connection = { query: vi.fn(async sql => sql.startsWith('SELECT DATABASE') ? [[{ db: 'dev_vue', uuid: 'fixture' }]]
    : [[{ 'Create Table': ddl }]]), beginTransaction: vi.fn(), commit: vi.fn(), rollback: vi.fn(), release: vi.fn(), destroy: vi.fn() }
  return { ddl, connection, repository: new MysqlAccountBackfillV2Repository({ getConnection: async () => connection }) }
}
beforeEach(() => { Object.assign(state, { count: 147, complete: true, status: 'completed', journal: true, checksum: 'a'.repeat(64) }) })

it('binds the complete registry and separates old wave identity even with identical sources', async () => {
  const { connection, repository, ddl } = fixture()
  expect(repository.sourceEvidence).toBe(true)
  const current = await repository.transaction(tx => tx.targetIdentity())
  const previousHash = hash({ adapterVersion: 'coordinated-account/v1', mode: 'inplace-account-v2',
    sources: ['users', 'trading_accounts', 'mt5_account_ownership_history'].map(name => ({ name, hash: tableDefinitionHash(ddl) })),
    routes: inplaceAccountTargets, steps: Array.from({ length: 147 }, (_, i) => ({ id: `step-${i}`, checksum: state.checksum })) })
  expect(current.schemaHash).not.toBe(previousHash)
  state.checksum = 'b'.repeat(64)
  expect((await readAccountBackfillV2Identity(connection)).schemaHash).not.toBe(current.schemaHash)
  expect(connection.commit).toHaveBeenCalledOnce()
})

it.each(['count', 'incomplete', 'reconcile', 'journal'])('rejects %s before committing a backfill', async kind => {
  if (kind === 'count') state.count = 146
  if (kind === 'incomplete') state.complete = false
  if (kind === 'reconcile') state.status = 'reconcile'
  if (kind === 'journal') state.journal = false
  const { connection, repository } = fixture()
  await expect(repository.transaction(tx => tx.targetIdentity())).rejects.toThrow('backfill_')
  expect(connection.commit).not.toHaveBeenCalled()
  expect(connection.rollback).toHaveBeenCalledOnce()
})

it('retains commit-unknown handling without replaying the transaction', async () => {
  const { repository, connection } = fixture()
  connection.commit.mockRejectedValue(Error('response lost'))
  const work = vi.fn(tx => tx.targetIdentity())
  await expect(repository.transaction(work)).rejects.toThrow('backfill_commit_unknown')
  expect(work).toHaveBeenCalledOnce()
  expect(connection.destroy).toHaveBeenCalledOnce()
  expect(connection.release).not.toHaveBeenCalled()
})
