import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { freezeAccountWave } from '../scripts/lib/v4-account-wave-manifest.mjs'
const root = new URL('../docs/migration/', import.meta.url)
const json = async name => JSON.parse(await readFile(new URL(name, root), 'utf8'))
const backup = await json('dev-vue-inplace-backup-20260906.json')
const columnProof = await json('dev-vue-inplace-column-rehearsal-20260906.json')
const review = await json('dev-vue-account-ownership-review-v2-20260906.json')
const fixture = () => structuredClone({ backup, columnProof, review, targetIdentity: review.targetIdentity,
  originalRows: structuredClone(columnProof.parity), tools: [{ path: 'scripts/a.mjs', sha256: 'a'.repeat(64) }, { path: 'scripts/b.mjs', sha256: 'b'.repeat(64) }] })
it('freezes verified inputs without inventing time bases or enabling writes', () => {
  const result = freezeAccountWave(fixture())
  expect(result.executable).toBe(false); expect(result.admission.approved).toBe(false)
  expect(result.timeBases).toEqual({ trading_accounts: null, mt5_account_ownership_history: null })
  expect(result.scope).toMatchObject({ sourceRows: 278, activation: false, rename: false, deleteLegacy: false })
})
it('rejects an altered source snapshot, conflicting ownership or another target schema', () => {
  const changed = fixture(); changed.originalRows[0].sha256 = '0'.repeat(64)
  expect(() => freezeAccountWave(changed)).toThrow('account_wave_source_changed')
  const conflicting = fixture(); conflicting.review.ownership.currentOwnershipConsistent = false
  expect(() => freezeAccountWave(conflicting)).toThrow('account_wave_ownership_unresolved')
  const target = fixture(); target.targetIdentity = { ...target.targetIdentity, schemaHash: '0'.repeat(64) }
  expect(() => freezeAccountWave(target)).toThrow('account_wave_target_mismatch')
})
it('is insensitive to tool listing order but changes with an execution tool revision', () => {
  const input = fixture(), initial = freezeAccountWave(input)
  input.tools.reverse(); expect(freezeAccountWave(input).manifestHash).toBe(initial.manifestHash)
  input.tools[0].sha256 = 'c'.repeat(64)
  expect(freezeAccountWave(input).manifestHash).not.toBe(initial.manifestHash)
})
it('refuses duplicate tool paths and path traversal in the frozen execution set', () => {
  const input = fixture(); input.tools.push({ ...input.tools[0] })
  expect(() => freezeAccountWave(input)).toThrow('account_wave_tools_invalid')
  input.tools = [{ path: '../other.mjs', sha256: 'a'.repeat(64) }]
  expect(() => freezeAccountWave(input)).toThrow('account_wave_tools_invalid')
})
