import { describe, expect, it } from 'vitest'
import { canonicalEvidence } from '../src/modules/trade-history/domain/terminal-history-projection.js'
import { readTradeCostEvidence } from '../src/modules/trade-history/domain/trade-cost-evidence.js'

const read = (value: Record<string, unknown>) => {
  const evidence = canonicalEvidence(value)
  return readTradeCostEvidence(evidence.json, evidence.hash)
}
describe('original terminal cost evidence', () => {
  it('distinguishes omitted fees from explicit zero without changing decimal text', () => {
    const incomplete = read({ profit: '10.00', commission: '-1.20', swap: 0 })
    expect(incomplete.complete).toBe(false)
    expect(incomplete.fields.fee.status).toBe('missing')
    const explicit = read({ profit: '10.00', commission: '-1.20', swap: 0, fee: '0.00' })
    expect(explicit.complete).toBe(true)
    expect(explicit.fields.commission).toEqual({ status: 'explicit', value: '-1.20' })
    expect(explicit.fields.fee).toEqual({ status: 'explicit', value: '0.00' })
  })
  it('does not accept null, malformed costs or altered original evidence', () => {
    expect(read({ profit: 0, commission: null, swap: '', fee: false }).fields).toMatchObject({
      commission: { status: 'missing' }, swap: { status: 'missing' }, fee: { status: 'invalid' },
    })
    const evidence = canonicalEvidence({ profit: 1 })
    expect(() => readTradeCostEvidence('{"profit":2}', evidence.hash)).toThrow('trade_cost_evidence_invalid')
    expect(() => readTradeCostEvidence('null', evidence.hash)).toThrow('trade_cost_evidence_invalid')
  })
})
