import { describe, expect, it } from 'vitest'
import { compareBoundaryDebt } from '../scripts/lib/boundary-debt.mjs'

const edge = { rule: 'cross-module-internal', source: 'server/src/modules/a/application/use.ts', target: 'server/src/modules/b/domain/value.ts', kind: 'import', typeOnly: true }
const baseline = findings => ({ version: 1, entries: findings.map(finding => ({ finding, count: 1, owner: 'a', phase: 'P1', reason: 'Move to public application port' })) })

describe('exact server boundary debt', () => {
  it('does not allow private entry or composition access to be added as grandfathered debt', () => {
    for (const rule of ['module-entry-access', 'composition-access']) {
      expect(() => compareBoundaryDebt([], baseline([{ ...edge, rule }]))).toThrow('invalid_boundary_debt_entry')
    }
  })
  it('separates frontend debt from server debt and never permits cross-application exceptions', () => {
    const finding = { ...edge, rule: 'feature-internal', source: 'frontend/apps/trade/src/App.vue', target: 'frontend/apps/trade/src/features/home/private.ts' }
    expect(compareBoundaryDebt([finding], baseline([finding]), 'frontend').passed).toBe(true)
    expect(() => compareBoundaryDebt([finding], baseline([finding]))).toThrow('invalid_boundary_debt_entry')
    expect(() => compareBoundaryDebt([], baseline([{ ...finding, rule: 'cross-application' }]), 'frontend')).toThrow('invalid_boundary_debt_entry')
    expect(compareBoundaryDebt([{ ...finding, typeOnly: false }], baseline([finding]), 'frontend').passed).toBe(false)
  })

  it('ignores line shifts but catches new edges and stale exceptions independently', () => {
    expect(compareBoundaryDebt([{ ...edge, line: 200 }], baseline([{ ...edge, line: 1 }])).passed).toBe(true)
    const replacement = { ...edge, target: 'server/src/modules/c/domain/value.ts' }
    const result = compareBoundaryDebt([replacement], baseline([edge]))
    expect(result.passed).toBe(false)
    expect(result.added).toHaveLength(1)
    expect(result.stale).toHaveLength(1)
    expect(compareBoundaryDebt([], baseline([edge])).stale).toHaveLength(1)
  })

  it('rejects type-to-runtime changes, import-kind changes and repeated occurrences', () => {
    for (const changed of [{ ...edge, typeOnly: false }, { ...edge, kind: 'export' }]) {
      expect(compareBoundaryDebt([changed], baseline([edge])).passed).toBe(false)
    }
    const result = compareBoundaryDebt([edge, edge], baseline([edge]))
    expect(result.added[0]).toMatchObject({ count: 2, expectedCount: 1 })
  })

  it('detects extra edges within the same cycle membership', () => {
    const cycle = { rule: 'source-cycle', source: 'a', target: 'a -> b -> c', runtime: false, evidence: [
      { source: 'a', target: 'b', kind: 'import', typeOnly: true },
      { source: 'b', target: 'c', kind: 'import', typeOnly: true },
      { source: 'c', target: 'a', kind: 'import', typeOnly: true },
    ] }
    expect(compareBoundaryDebt([{ ...cycle, evidence: [...cycle.evidence].reverse() }], baseline([cycle])).passed).toBe(true)
    const result = compareBoundaryDebt([{ ...cycle, evidence: [...cycle.evidence, { source: 'b', target: 'a', kind: 'import', typeOnly: true }] }], baseline([cycle]))
    expect(result.added).toHaveLength(1)
    expect(result.stale).toHaveLength(1)
  })

  it('rejects wildcard, duplicate, undocumented-rule and unowned exceptions', () => {
    expect(() => compareBoundaryDebt([], baseline([{ ...edge, target: '*' }]))).toThrow('boundary_wildcards_forbidden')
    expect(() => compareBoundaryDebt([], baseline([edge, edge]))).toThrow('duplicate_boundary_debt')
    expect(() => compareBoundaryDebt([], baseline([{ ...edge, rule: 'unresolved-dependency' }]))).toThrow('invalid_boundary_debt_entry')
    const unowned = baseline([edge]); unowned.entries[0].owner = ''
    expect(() => compareBoundaryDebt([], unowned)).toThrow('invalid_boundary_debt_entry')
    expect(() => compareBoundaryDebt([], baseline([{ rule: 'module-cycle', source: 'a', target: 'a -> b' }]))).toThrow('cycle_evidence_required')
  })
})
