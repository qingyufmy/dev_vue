import { describe, expect, it } from 'vitest'
import type { PoolConnection } from 'mysql2/promise'
import { updateReferralRulesInTransaction, type ReferralRuleChangeRequest } from '../src/modules/commerce/infrastructure/mysql-referral-rule-writer.js'

const request = (): ReferralRuleChangeRequest => ({ requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', actorUserId: 1,
  changes: [{ id: 2, expectedRevision: '1', rateBps: 0, enabled: false }, { id: 1, expectedRevision: '1', rateBps: 2000, enabled: true }] })
function fixture() {
  const rows = new Map([1, 2].map(id => [id, { id: String(id), revision: '1', rate_bps: '1000', enabled: '1' }]))
  const calls: { sql: string; values: unknown[] }[] = [], audits: unknown[][] = []
  let failAudit = false
  const connection = { execute: async (sql: string, values: unknown[]) => {
    calls.push({ sql, values })
    if (sql.startsWith('SELECT')) return [[rows.get(Number(values[0]))].filter(Boolean), []]
    if (sql.startsWith('UPDATE')) {
      const row = rows.get(Number(values[3]))
      if (!row || row.revision !== values[4]) return [{ affectedRows: 0 }, []]
      Object.assign(row, { rate_bps: String(values[0]), enabled: String(values[1]), revision: String(values[2]) })
      return [{ affectedRows: 1 }, []]
    }
    if (sql.startsWith('INSERT')) { if (failAudit) throw Error('audit_unavailable'); audits.push(values); return [{ affectedRows: 1 }, []] }
    throw Error('unexpected SQL')
  } } as unknown as PoolConnection
  return { rows, calls, audits, connection, failAudit: () => { failAudit = true } }
}
describe('versioned referral rule writer', () => {
  it('locks every rule in stable order before writing and records exact before/after values', async () => {
    const f = fixture()
    expect(await updateReferralRulesInTransaction(f.connection, request())).toEqual([{ id: 1, revision: '2' }, { id: 2, revision: '2' }])
    expect(f.calls.slice(0, 2).map(call => call.values)).toEqual([[1], [2]])
    expect(f.calls.slice(0, 2).every(call => call.sql.endsWith('FOR UPDATE'))).toBe(true)
    expect(f.audits.map(row => [row[0], ...row.slice(4)])).toEqual([[1, '1000', 2000, '1', 1], [2, '1000', 0, '1', 0]])
  })
  it('rejects a conflict on the last locked row without any writes', async () => {
    const f = fixture(); f.rows.get(2)!.revision = '2'
    await expect(updateReferralRulesInTransaction(f.connection, request())).rejects.toThrow('revision_conflict')
    expect(f.calls.every(call => call.sql.startsWith('SELECT'))).toBe(true)
  })
  it('propagates audit failure so the transaction owner must roll back', async () => {
    const f = fixture(); f.failAudit()
    await expect(updateReferralRulesInTransaction(f.connection, request())).rejects.toThrow('audit_unavailable')
    expect(f.rows.get(1)!.revision).toBe('2') // deliberately not a claimed automatic rollback
    expect(f.rows.get(2)!.revision).toBe('1')
    expect(f.audits).toHaveLength(0)
  })
  it('rejects duplicate rules, bad rates and overflow before SQL', async () => {
    for (const change of [{ id: 1 }, { rateBps: 0.5 }, { rateBps: -1 }, { rateBps: 10001 }, { expectedRevision: '18446744073709551615' }]) {
      const f = fixture(), input = request(); Object.assign(input.changes[0]!, change)
      await expect(updateReferralRulesInTransaction(f.connection, input)).rejects.toThrow('update_invalid')
      expect(f.calls).toHaveLength(0)
    }
  })
  it('increments large revisions exactly and rejects a stale retry', async () => {
    const f = fixture(), input = request(); input.changes = [{ id: 1, expectedRevision: '9007199254740993', rateBps: 1, enabled: true }]
    f.rows.get(1)!.revision = '9007199254740993'
    expect(await updateReferralRulesInTransaction(f.connection, input)).toEqual([{ id: 1, revision: '9007199254740994' }])
    await expect(updateReferralRulesInTransaction(f.connection, input)).rejects.toThrow('revision_conflict')
    expect(f.audits).toHaveLength(1)
  })
})
