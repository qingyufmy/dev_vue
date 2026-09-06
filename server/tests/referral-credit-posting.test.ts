import type { PoolConnection } from 'mysql2/promise'
import { expect, it } from 'vitest'
import { postReferralCreditInTransaction, type ReferralCreditPosting } from '../src/modules/commerce/infrastructure/mysql-referral-credit.js'

const command: ReferralCreditPosting = { userId: 1, expectedRevision: '1', kind: 'order_debit', sourceKey: 'a'.repeat(64), sourceSha256: 'b'.repeat(64), amount: '29' }
function fixture() {
  const state = { balance: '80.00000000', revision: '1', latestBalance: '80.00000000', latestRevision: '1',
    event: null as null | { delta: string; source_sha256: string; resulting_balance: string; account_revision: string }, updated: 1 }
  const writes: { sql: string; values: unknown[] }[] = []
  const connection = { async execute(sql: string, values: unknown[]) {
    if (sql.startsWith('SELECT referral_credit')) return [[{ balance: state.balance, revision: state.revision }]]
    if (sql.startsWith('SELECT resulting_balance')) return [[{ resulting_balance: state.latestBalance, account_revision: state.latestRevision }]]
    if (sql.startsWith('SELECT delta')) return [state.event ? [state.event] : []]
    writes.push({ sql, values }); return [{ affectedRows: state.updated }]
  } } as unknown as PoolConnection
  return { state, writes, connection }
}
it('appends the exact debit and changes the balance in the caller transaction', async () => {
  const f = fixture()
  expect(await postReferralCreditInTransaction(f.connection, command)).toEqual({ applied: true, eventRevision: '2', eventBalance: '51.00000000' })
  expect(f.writes[0]!.values).toEqual([1, '2', 'order_debit', command.sourceKey, '80.00000000', '-29.00000000', '51.00000000', command.sourceSha256])
  expect(f.writes[1]!.values).toEqual(['51.00000000', '2', 1, '1'])
})
it('returns the original event on a retry even after later revisions', async () => {
  const f = fixture(); f.state.revision = f.state.latestRevision = '5'
  f.state.event = { delta: '-29.00000000', source_sha256: command.sourceSha256, account_revision: '2', resulting_balance: '51.00000000' }
  expect(await postReferralCreditInTransaction(f.connection, command)).toMatchObject({ applied: false, eventRevision: '2' })
  expect(f.writes).toEqual([])
})
it('rejects reusing an event key for different money', async () => {
  const f = fixture(); f.state.event = { delta: '-1.00000000', source_sha256: command.sourceSha256, account_revision: '2', resulting_balance: '79.00000000' }
  await expect(postReferralCreditInTransaction(f.connection, command)).rejects.toThrow('referral_event_conflict')
  expect(f.writes).toEqual([])
})
it('rejects divergent ledger, stale revision and overdraft before writing', async () => {
  const f = fixture(); f.state.latestBalance = '90.00000000'
  await expect(postReferralCreditInTransaction(f.connection, command)).rejects.toThrow('referral_ledger_diverged')
  f.state.latestBalance = f.state.balance
  await expect(postReferralCreditInTransaction(f.connection, { ...command, expectedRevision: '2' })).rejects.toThrow('referral_revision_conflict')
  await expect(postReferralCreditInTransaction(f.connection, { ...command, amount: '81' })).rejects.toThrow('referral_credit_insufficient')
  expect(f.writes).toEqual([])
})
it('requires the owner to roll back when the balance update fails', async () => {
  const f = fixture(); f.state.updated = 0
  await expect(postReferralCreditInTransaction(f.connection, command)).rejects.toThrow('referral_revision_conflict')
  expect(f.writes).toHaveLength(2)
})
