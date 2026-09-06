import { describe, expect, it } from 'vitest'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'
import { proposeAccountMappings } from '../scripts/lib/v4-account-mapping-candidates.mjs'

const account = (id, userId, server = 'Broker', login = '00123') => ({ id, userId, server, login, sourceHash: hash(['account', id]) })
const terminal = (id, userId, platform = 'mt5', server = 'BROKER', login = '00123') => ({ id, userId, platform, server, login, sourceHash: hash(['terminal', id]) })
const binding = (currency = 'USD') => ({ server: 'BROKER', login: '00123', currentUserId: '2', currentAccountId: '2', currency, sourceHash: hash('binding') })
const input = () => ({ accounts: [account('1', '1'), account('2', '2')], terminals: [terminal('old', '1'), terminal('new', '2')], bindings: [binding()] })
describe('account mapping candidates with exact scoped evidence', () => {
  it('retains every source ID and separate settings user in a reviewed merge candidate', () => {
    const data = input(), before = structuredClone(data), result = proposeAccountMappings('legacy', data)
    expect(result.groups).toHaveLength(1)
    expect(result.groups[0]).toMatchObject({ sourceAccountIds: ['1', '2'], settingsUserIds: ['1', '2'], mergeReviewRequired: true, settingsConflict: false })
    expect(result.candidates.map(c => c.currency)).toEqual(['USD', 'USD'])
    expect(result.readyForBackfill).toBe(false)
    expect(data).toEqual(before)
  })
  it('does not borrow platform evidence from another user or table naming', () => {
    const data = input(); data.terminals.shift()
    const result = proposeAccountMappings('legacy', data)
    expect(result.candidates[0]).toMatchObject({ candidateKey: null, platform: null, issues: ['platform_evidence_missing'] })
  })
  it('blocks conflicting platforms but keeps mt4 and mt5 identities separate', () => {
    const data = input(); data.terminals[0].platform = 'mt4'
    expect(proposeAccountMappings('legacy', data).groups).toHaveLength(2)
    data.terminals.push(terminal('conflict', '1', 'mt5'))
    expect(proposeAccountMappings('legacy', data).candidates[0].issues).toContain('platform_evidence_ambiguous')
  })
  it('preserves login leading zeros and refuses whitespace or non-ASCII normalization', () => {
    const data = input(); data.accounts[0].login = '123'
    expect(proposeAccountMappings('legacy', data).candidates[0].issues).toContain('platform_evidence_missing')
    data.accounts[0].server = ' Broker '
    expect(() => proposeAccountMappings('legacy', data)).toThrow('account_candidate_identity_requires_review')
    data.accounts[0].server = 'Bróker'
    expect(() => proposeAccountMappings('legacy', data)).toThrow('account_candidate_identity_requires_review')
  })
  it('rejects missing/oversized currencies and contradictory binding references', () => {
    for (const currency of [null, '', 'USD ', 'X'.repeat(13), '美元']) {
      const data = input(); data.bindings[0].currency = currency
      expect(proposeAccountMappings('legacy', data).candidates[0]).toMatchObject({ currency: null, issues: ['currency_unrepresentable'] })
    }
    const data = input(); data.bindings[0].currentUserId = '1'
    expect(proposeAccountMappings('legacy', data).candidates[0].issues).toContain('currency_binding_reference_invalid')
  })
  it('flags duplicate per-user settings and keeps keys independent of input order or snapshot hashes', () => {
    const data = input(), first = proposeAccountMappings('legacy', data)
    data.accounts.reverse(); data.terminals.reverse(); data.accounts[0].sourceHash = hash('new-snapshot')
    expect(proposeAccountMappings('legacy', data).groups).toEqual(first.groups)
    expect(proposeAccountMappings('other-source', data).groups[0].candidateKey).not.toBe(first.groups[0].candidateKey)
    data.accounts[0].userId = '1'
    expect(proposeAccountMappings('legacy', data).groups[0].settingsConflict).toBe(true)
  })
  it('rejects duplicate source IDs and treats case-variant bindings as ambiguous', () => {
    const data = input(); data.accounts.push(data.accounts[0])
    expect(() => proposeAccountMappings('legacy', data)).toThrow('account_candidate_account_duplicate')
    data.accounts.pop(); data.bindings.push({ ...binding(), server: 'Broker', sourceHash: hash('second') })
    expect(proposeAccountMappings('legacy', data).candidates[0].issues).toContain('currency_binding_ambiguous')
  })
})
