import { describe, expect, it } from 'vitest'
import { DEFAULT_RISK_POLICY, resolveRiskPolicy, readPlatformRiskValues, readPlatformRiskControls, type RiskPolicyBoundary, type AccountRiskPolicyPatch } from '../src/modules/risk/index.js'

const boundary = { allowedMin: 0.01, allowedMax: 0.2, lockedValue: null, userEditable: true }
function resolve(controls: RiskPolicyBoundary['controls'], account: AccountRiskPolicyPatch = {}) {
  return resolveRiskPolicy({ userId: 7, accountId: '42', platformPolicyVersionId: '1', accountPolicyVersionId: null,
    policySetRevision: 0, platform: { values: { ...DEFAULT_RISK_POLICY }, globalKillSwitch: false, revision: 1, ...(controls ? { controls } : {}) },
    account, updatedAt: '2026-09-09T00:00:00.000Z' })
}

describe('independent platform risk controls', () => {
  it('reads normalized persisted controls without losing independent bounds', () => {
    const raw = JSON.stringify({ values: { maxOrderVolume: 0.05 }, controls: { maxOrderVolume: boundary } })
    expect(readPlatformRiskValues(raw).maxOrderVolume).toBe(0.05)
    expect(readPlatformRiskControls(raw)).toEqual({ maxOrderVolume: boundary })
    expect(resolve(readPlatformRiskControls(raw), { maxOrderVolume: 0.1 }).values.maxOrderVolume).toBe(0.1)
  })
  it('permits an explicit upper boundary distinct from the platform default', () => {
    expect(resolve({ maxOrderVolume: boundary }, { maxOrderVolume: 0.1 }).values.maxOrderVolume).toBe(0.1)
    expect(() => resolve(undefined, { maxOrderVolume: 0.1 })).toThrow()
    expect(() => resolve({ maxOrderVolume: boundary }, { maxOrderVolume: 0.21 })).toThrow()
    expect(() => resolve({ maxOrderVolume: boundary }, { maxOrderVolume: 0.001 })).toThrow()
  })
  it('applies locked platform values over historical account overrides and removes editing', () => {
    const policy = resolve({ maxOrderVolume: { ...boundary, lockedValue: 0.02 } }, { maxOrderVolume: 0.1 })
    expect(policy.values.maxOrderVolume).toBe(0.02)
    expect(policy.editableFields).not.toContain('maxOrderVolume')
  })
  it('disabled editing uses bounded platform default rather than an old account override', () => {
    const policy = resolve({ maxOrderVolume: { ...boundary, allowedMin: 0.08, userEditable: false } }, { maxOrderVolume: 0.15 })
    expect(policy.values.maxOrderVolume).toBe(0.08)
    expect(policy.editableFields).not.toContain('maxOrderVolume')
  })
  it.each([{ ...boundary, allowedMin: 0.3 }, { ...boundary, lockedValue: 0.3 }, { ...boundary, allowedMin: NaN },
    { ...boundary, allowedMin: 0 }, { ...boundary, unexpected: 1 }])('rejects invalid controls', control => {
    expect(() => resolve({ maxOrderVolume: control })).toThrow()
  })
  it('rejects fractional count boundaries and does not make system fields editable', () => {
    expect(() => resolve({ maxDailyOpenCount: { ...boundary, allowedMin: 1.1, allowedMax: 20 } })).toThrow()
    const policy = resolve({ maxQuoteAgeSeconds: { allowedMin: 1, allowedMax: 20, lockedValue: 2, userEditable: true } })
    expect(policy.values.maxQuoteAgeSeconds).toBe(2)
    expect(policy.editableFields).not.toContain('maxQuoteAgeSeconds')
  })
})
