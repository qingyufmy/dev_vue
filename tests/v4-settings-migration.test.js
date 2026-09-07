import { beforeEach, expect, it, vi } from 'vitest'
import { hash, streamIdentity } from '../scripts/lib/v4-backfill-contract.mjs'
import { settingsCredentialFixture } from './fixtures/settings-credential-fixture.mjs'
import { createCredentialSettingsBackfill } from '../scripts/lib/v4-settings-credential-backfill.mjs'
import { createSettingsMigration, settingsMigrationManifestHash } from '../scripts/lib/v4-settings-migration.mjs'

const runner = vi.hoisted(() => ({ prepareBackfillRun: vi.fn(), executeBackfillBatch: vi.fn(), recoverBackfillBatch: vi.fn() }))
vi.mock('../scripts/lib/v4-settings-backfill-runner.mjs', () => runner)
beforeEach(() => { vi.resetAllMocks(); runner.recoverBackfillBatch.mockResolvedValue({ status: 'committed' }) })
function fixture() {
  const f = settingsCredentialFixture(), recipe = createCredentialSettingsBackfill([f.row], f.options)
  const spec = { runId: recipe.runId, admission: { approved: true, blockers: [] }, bindings: {
    logicalSourceId: 'fixture', sourceDatabase: 'dev_vue', targetDatabase: 'dev_vue', mirrorDatabase: 'mirror',
    targetServerUuid: recipe.runId, snapshotHash: recipe.sourceHash, schemaHash: 'c'.repeat(64), manifestHash: 'd'.repeat(64),
    transformHash: recipe.transformHash, storageMode: 'inplace-settings-v1', streams: [recipe.stream] } }
  const input = { kind: 'credential', sources: [f.row], options: f.options, spec }
  const row = recipe.batches[0].rows[0]
  const target = structuredClone(row.payload.entry.target)
  const repository = { transaction: vi.fn(work => work({
    targetIdentity: async () => ({ database: 'dev_vue', serverUuid: recipe.runId, schemaHash: spec.bindings.schemaHash, storageMode: 'inplace-settings-v1' }),
    findRun: async () => ({ bindings: spec.bindings, bindingsHash: hash(spec.bindings) }),
    connection: { execute: async sql => {
      if (sql.includes('FROM system_config')) return [[f.row]]
      if (sql.includes('FROM system_settings')) return [[target]]
      if (sql.includes('FROM data_migration_source_rows')) return [[{ source_pk_sha256: hash(row.pk), source_bytes_sha256: hash(f.row), source_payload_json: recipe.sourceEvidence(streamIdentity(recipe.stream), row) }]]
      throw Error('unexpected_query')
    } },
  })) }
  return { input, target, repository, migration: createSettingsMigration(input) }
}
it('applies the fixed recipe then independently verifies targets and protected source recovery', async () => {
  const f = fixture()
  expect((await f.migration.run('apply', f.repository)).status).toBe('verified')
  expect(runner.prepareBackfillRun).toHaveBeenCalledOnce()
  expect(runner.executeBackfillBatch).toHaveBeenCalledOnce()
  expect(f.repository.transaction).toHaveBeenCalledOnce()
})
it('stops on commit unknown without calling recovery or a second write', async () => {
  const f = fixture(); runner.executeBackfillBatch.mockRejectedValue(Error('backfill_commit_unknown'))
  await expect(f.migration.run('apply', f.repository)).rejects.toThrow('commit_unknown')
  expect(runner.executeBackfillBatch).toHaveBeenCalledOnce()
  expect(runner.recoverBackfillBatch).not.toHaveBeenCalled()
  expect(f.repository.transaction).not.toHaveBeenCalled()
})
it('recovery does not turn not_committed or unknown into an apply', async () => {
  for (const status of ['not_committed', 'unknown']) {
    const f = fixture(); runner.recoverBackfillBatch.mockResolvedValue({ status })
    expect((await f.migration.run('recover', f.repository)).status).toBe(status)
    expect(f.repository.transaction).not.toHaveBeenCalled()
  }
  expect(runner.prepareBackfillRun).not.toHaveBeenCalled()
  expect(runner.executeBackfillBatch).not.toHaveBeenCalled()
})
it('verification detects a target change and never prepares or applies a run', async () => {
  const f = fixture(); f.target.label = 'changed'
  await expect(f.migration.run('verify', f.repository)).rejects.toThrow('audit_failed')
  expect(runner.prepareBackfillRun).not.toHaveBeenCalled()
  expect(runner.executeBackfillBatch).not.toHaveBeenCalled()
})
it('rejects a mismatched transform or ordinary route for credential rows', () => {
  const f = fixture(); f.input.spec.bindings.transformHash = 'e'.repeat(64)
  expect(() => createSettingsMigration(f.input)).toThrow('recipe_binding')
  expect(() => createSettingsMigration({ ...f.input, kind: 'ordinary' })).toThrow('source_scope')
})
it('binds the external manifest while excluding only the self-referential checksum', () => {
  const manifest = { kind: 'ordinary', spec: { bindings: { manifestHash: 'a'.repeat(64) } }, sourceIds: ['1'] }
  const first = settingsMigrationManifestHash(manifest)
  manifest.spec.bindings.manifestHash = first
  expect(settingsMigrationManifestHash(manifest)).toBe(first)
  manifest.sourceIds = ['2']
  expect(settingsMigrationManifestHash(manifest)).not.toBe(first)
})
