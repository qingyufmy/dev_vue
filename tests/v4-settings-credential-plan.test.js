import { expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'
import { prepareCredentialPlan, verifyCredentialPlan, persistCredentialPlan } from '../scripts/lib/v4-settings-credential-plan.mjs'

const binding = { runId: 'ffffffff-ffff-ffff-ffff-ffffffff0031', snapshotHash: 'a'.repeat(64) }
const sources = [{ sourceId: '3', namespace: 'qiniu', key: 'secret_key', sourceRowHash: 'b'.repeat(64), sourceFormat: 'plaintext', value: 'fixture-secret-only' }]
const options = { keyring: new Map([['v1', Buffer.alloc(32, 12)]]), activeVersion: 'v1' }
it('binds exact reviewed source, scope and ciphertext without storing plaintext', () => {
  const plan = prepareCredentialPlan(sources, binding, options)
  expect(JSON.stringify(plan)).not.toContain(sources[0].value)
  expect(verifyCredentialPlan(plan, sources, binding, options)).toEqual(plan)
  for (const change of [{ sourceId: '4' }, { sourceRowHash: 'c'.repeat(64) }, { value: 'changed' }]) {
    expect(() => verifyCredentialPlan(plan, [{ ...sources[0], ...change }], binding, options)).toThrow()
  }
  expect(() => verifyCredentialPlan(plan, sources, { ...binding, snapshotHash: 'c'.repeat(64) }, options)).toThrow('credential_plan_mismatch')
})
it('rejects edited targets even when someone recomputes the non-secret checksum', () => {
  const plan = prepareCredentialPlan(sources, binding, options)
  plan.entries[0].targetValue = prepareCredentialPlan([{ ...sources[0], value: 'other' }], binding, options).entries[0].targetValue
  const { checksum, ...body } = plan
  plan.checksum = hash(body)
  expect(() => verifyCredentialPlan(plan, sources, binding, options)).toThrow('target_conflict')
})
it('persists once and recovers identical target without requiring an active encryption key', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'settings-plan-'))
  try {
    const path = join(directory, 'plan.json')
    const first = await persistCredentialPlan(path, sources, binding, options)
    const bytes = await readFile(path)
    const recovered = await persistCredentialPlan(path, sources, binding, { keyring: options.keyring })
    expect(recovered).toEqual(first)
    expect(await readFile(path)).toEqual(bytes)
    await expect(persistCredentialPlan(path, sources, binding, { ...options, expectedChecksum: 'e'.repeat(64) })).rejects.toThrow('credential_plan_expected_checksum')
    await expect(persistCredentialPlan(path, sources, { ...binding, snapshotHash: 'd'.repeat(64) }, options)).rejects.toThrow('credential_plan_mismatch')
    expect(await readFile(path)).toEqual(bytes)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
it('does not regenerate a lost admitted plan', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'settings-plan-'))
  try {
    await expect(persistCredentialPlan(join(directory, 'missing.json'), sources, binding,
      { ...options, expectedChecksum: 'f'.repeat(64) })).rejects.toThrow('credential_plan_committed_file_missing')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
it('leaves a partial write untouched and fails before returning any usable plan', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'settings-plan-'))
  try {
    const path = join(directory, 'plan.json')
    await writeFile(path, '{partial')
    await expect(persistCredentialPlan(path, sources, binding, options)).rejects.toThrow('credential_plan_file_invalid')
    expect(await readFile(path, 'utf8')).toBe('{partial')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
it('rejects duplicate identities and non-credential scopes', () => {
  expect(() => prepareCredentialPlan([...sources, ...sources], binding, options)).toThrow('credential_plan_source')
  expect(() => prepareCredentialPlan([{ ...sources[0], key: 'domain' }], binding, options)).toThrow('credential_plan_source')
})
