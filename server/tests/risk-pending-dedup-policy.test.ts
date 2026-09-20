import { expect, it } from 'vitest'
import { DEFAULT_RISK_POLICY, readPlatformRiskValues, readPlatformRiskControls, assertAccountPolicyPatch } from '../src/modules/risk/domain/risk.js'

it('preserves the legacy system default for V4 policies without the new field', () => {
  const { pendingDedupAtrMultiplier: _, ...old } = DEFAULT_RISK_POLICY
  expect(readPlatformRiskValues(old).pendingDedupAtrMultiplier).toBe(0.05)
})
it.each([0, 0.05, 5])('preserves an explicit ATR multiplier %s', value => {
  expect(readPlatformRiskValues({ ...DEFAULT_RISK_POLICY, pendingDedupAtrMultiplier: value }).pendingDedupAtrMultiplier).toBe(value)
})
it.each([-1, 5.01, '0.05', null])('rejects invalid ATR multiplier %s', value => {
  expect(() => readPlatformRiskValues({ ...DEFAULT_RISK_POLICY, pendingDedupAtrMultiplier: value })).toThrow('risk_platform_pending_dedup_invalid')
})
it('does not permit account patches or user-editable controls to change this system field', () => {
  expect(() => assertAccountPolicyPatch({ pendingDedupAtrMultiplier: 0.5 } as never)).toThrow('risk_policy_field_unknown')
  const control = { allowedMin: 0, allowedMax: 5, lockedValue: null, userEditable: false }
  expect(readPlatformRiskControls({ values: DEFAULT_RISK_POLICY, controls: { pendingDedupAtrMultiplier: control } })).toEqual({ pendingDedupAtrMultiplier: control })
  for (const patch of [{ userEditable: true }, { allowedMax: 6 }]) {
    expect(() => readPlatformRiskControls({ values: DEFAULT_RISK_POLICY, controls: { pendingDedupAtrMultiplier: { ...control, ...patch } } })).toThrow('risk_platform_control_invalid')
  }
})
