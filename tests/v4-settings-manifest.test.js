import { expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { settingsFixture } from './fixtures/settings-fixture.mjs'
import { settingsCredentialFixture } from './fixtures/settings-credential-fixture.mjs'
import { buildSettingsManifest, persistSettingsManifest } from '../scripts/lib/v4-settings-manifest.mjs'
import { settingsMigrationManifestHash, createSettingsMigration } from '../scripts/lib/v4-settings-migration.mjs'
const input = (credential = false) => {
  const f = credential ? settingsCredentialFixture() : settingsFixture()
  return { kind: credential ? 'credential' : 'ordinary', sources: [f.row], options: f.options,
    targetIdentity: { serverUuid: f.options.run.id, database: 'dev_vue', storageMode: 'inplace-settings-v1', schemaHash: 'c'.repeat(64) },
    logicalSourceId: 'fixture', mirrorDatabase: 'mirror', admission: { approved: true, blockers: [] },
    credentialPlanPath: credential ? './credential-plan.json' : null }
}
it('derives a deterministic complete ordinary manifest usable by the unified entry', () => {
  const f = input(), manifest = buildSettingsManifest(f)
  expect(buildSettingsManifest(f)).toEqual(manifest)
  expect(settingsMigrationManifestHash(manifest)).toBe(manifest.spec.bindings.manifestHash)
  const options = { ...manifest.options, evidenceCatalog: new Map(manifest.options.evidenceCatalog) }
  expect(createSettingsMigration({ ...manifest, sources: f.sources, options }).summary.sourceRows).toBe(1)
})
it('binds a protected plan without serializing its ciphertext or keys or source plaintext', () => {
  const f = input(true), manifest = buildSettingsManifest(f), text = JSON.stringify(manifest)
  expect(manifest.options.expectedPlanChecksum).toBe(f.options.credentialPlan.checksum)
  expect(text).not.toContain(f.sources[0].value)
  expect(text).not.toContain(f.options.credentialPlan.entries[0].targetValue)
  expect(text).not.toContain('credentialKeyring')
})
it('does not manufacture admission, time offsets or missing semantic evidence', () => {
  for (const mutate of [f => { f.admission.approved = false }, f => { f.admission.blockers = ['time_unknown'] },
    f => { f.options.basis.resolutions[0].createdAt.offsetMinutes = null }, f => { f.options.evidenceCatalog.clear() }]) {
    const f = input(); mutate(f); expect(() => buildSettingsManifest(f)).toThrow()
  }
})
it('rejects unknown option fields and a missing frozen credential binding', () => {
  const f = input(); f.options.password = 'unexpected'; expect(() => buildSettingsManifest(f)).toThrow('shape_invalid')
  const g = input(true); g.options.expectedPlanChecksum = 'f'.repeat(64); expect(() => buildSettingsManifest(g)).toThrow('plan_binding')
})
it('persists one manifest and refuses conflicts without changing the original file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'settings-manifest-'))
  try {
    const path = join(directory, 'manifest.json'), f = input(), manifest = buildSettingsManifest(f)
    expect(await persistSettingsManifest(path, manifest)).toEqual(manifest)
    const bytes = await readFile(path)
    expect(await persistSettingsManifest(path, buildSettingsManifest(f))).toEqual(manifest)
    f.logicalSourceId = 'changed'
    await expect(persistSettingsManifest(path, buildSettingsManifest(f))).rejects.toThrow('file_conflict')
    expect(await readFile(path)).toEqual(bytes)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
