import { describe, expect, it } from 'vitest'
import { epochMillisecondsToUtc, inspectWallClock } from '../scripts/lib/v4-identity-time.mjs'
import { inspectUserLifecycle } from '../scripts/lib/v4-identity-lifecycle.mjs'
import { auditOwnershipGraph } from '../scripts/lib/v4-identity-ownership-audit.mjs'

const active = () => ({ id: '1', role: 'user', plan: 'pro', deletionStatus: 'active', deletedAt: null, tokenVersion: '3' })
const graph = () => ({
  users: ['1', '2'],
  accounts: [{ id: '9007199254740993', userId: '2', server: 'Broker', login: '00123' }],
  intervals: [
    { id: '1', userId: '1', accountId: '9007199254740993', server: 'Broker', login: '00123', startedAt: '2020-01-01 00:00:00', endedAt: '2021-01-01 00:00:00' },
    { id: '2', userId: '2', accountId: '9007199254740993', server: 'Broker', login: '00123', startedAt: '2021-01-01 00:00:00', endedAt: null },
  ],
  bindings: [{ server: 'Broker', login: '00123', userId: '2', accountId: '9007199254740993' }],
})

describe('time semantics without an invented historical timezone', () => {
  it('validates leap days and precision but keeps wall clocks unresolved', () => {
    expect(inspectWallClock('2000-02-29 23:59:59.120000')).toMatchObject({ canonicalWallClock: '2000-02-29 23:59:59.120', utc: null, timeResolved: false })
    for (const value of ['1900-02-29 00:00:00', '2026-02-30 00:00:00', '0000-00-00 00:00:00', '2026-01-01 24:00:00', '2026-01-01 00:00:60', '2026-01-01T00:00:00Z']) expect(() => inspectWallClock(value)).toThrow('identity_time_invalid')
    expect(() => inspectWallClock('2026-01-01 00:00:00.000001')).toThrow('identity_time_precision_loss')
    expect(inspectWallClock(null).timeResolved).toBe(false)
  })
  it('converts only canonical bounded epoch ms, exactly at both MySQL range edges', () => {
    expect(epochMillisecondsToUtc('0').utc).toBe('1970-01-01 00:00:00.000')
    expect(epochMillisecondsToUtc('253402300799999').utc).toBe('9999-12-31 23:59:59.999')
    expect(epochMillisecondsToUtc('1').utc).toBe('1970-01-01 00:00:00.001')
    for (const value of ['253402300800000', '-1', '1.5', '01', '1e3', 1000]) expect(() => epochMillisecondsToUtc(value)).toThrow()
  })
})
describe('user lifecycle preservation', () => {
  it('preserves active state and token version without enabling migration', () => {
    expect(inspectUserLifecycle(active())).toMatchObject({ stateConsistent: true, sourceLoginEligible: true, candidate: { tokenVersion: '3', role: 'user' }, readyForBackfill: false })
  })
  it('retains anonymized users as ineligible without resetting their version', () => {
    expect(inspectUserLifecycle({ ...active(), plan: 'free', deletionStatus: 'anonymized', deletedAt: '2026-09-01 10:00:00' })).toMatchObject({ stateConsistent: true, sourceLoginEligible: false, candidate: { deletionStatus: 'anonymized', tokenVersion: '3' } })
  })
  it('blocks unknown/null states, privilege conflicts and inconsistent deletion evidence', () => {
    for (const patch of [{ deletionStatus: null }, { role: 'superadmin' }, { plan: null }, { tokenVersion: null }, { tokenVersion: '-1' }, { deletedAt: '2026-01-01 00:00:00' }, { deletionStatus: 'anonymized' }, { deletionStatus: 'anonymized', deletedAt: '2026-01-01 00:00:00', role: 'admin' }]) {
      expect(inspectUserLifecycle({ ...active(), ...patch })).toMatchObject({ stateConsistent: false, sourceLoginEligible: false, candidate: null })
    }
  })
})
describe('exact ownership graph without implicit owner grants', () => {
  it('preserves a historical owner distinct from the current settings user', () => {
    const input = graph(), before = structuredClone(input)
    expect(auditOwnershipGraph(input)).toMatchObject({ issues: [], exactRelationsConsistent: true, temporalOrderVerified: false, readyForBackfill: false })
    expect(input).toEqual(before)
  })
  it('rejects missing users/accounts and keeps case/leading-zero mismatches unresolved', () => {
    const input = graph(); input.users = ['2']; input.intervals[0].accountId = '404'; input.bindings[0].login = '123'; input.intervals[1].server = 'BROKER'
    expect(auditOwnershipGraph(input).issues.map(i => i.code)).toEqual(expect.arrayContaining(['interval_user_missing', 'interval_account_missing', 'interval_identity_unresolved', 'binding_identity_unresolved', 'binding_open_interval_disagrees']))
  })
  it('detects duplicate entities, multiple open owners and absent bindings', () => {
    const input = graph(); input.accounts.push({ ...input.accounts[0] }); input.intervals[0].endedAt = null; input.bindings = []
    expect(auditOwnershipGraph(input).issues.map(i => i.code)).toEqual(expect.arrayContaining(['duplicate_account_id', 'account_identity_merge_unresolved', 'multiple_open_owners', 'open_interval_binding_missing']))
  })
  it('does not claim overlap validation from valid but unproven wall clocks', () => {
    const input = graph(); input.intervals[0].endedAt = '2025-01-01 00:00:00'
    const result = auditOwnershipGraph(input)
    expect(result.temporalOrderVerified).toBe(false)
    expect(result.blockers).toContain('historical_time_basis_unverified')
    input.intervals[0].startedAt = null
    expect(auditOwnershipGraph(input).issues.map(i => i.code)).toContain('interval_time_invalid')
  })
})
