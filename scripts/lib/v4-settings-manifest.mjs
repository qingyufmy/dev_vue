import { open, readFile } from 'node:fs/promises'
import { canonical, exactKeys, requireBackfill as check } from './v4-backfill-contract.mjs'
import { createSettingsBackfill } from './v4-settings-backfill.mjs'
import { createCredentialSettingsBackfill } from './v4-settings-credential-backfill.mjs'
import { createSettingsMigration, settingsMigrationManifestHash } from './v4-settings-migration.mjs'

// Input evidence is reviewed externally. This function derives bindings but never
// approves unresolved data, supplies time offsets or generates a new credential.
export function buildSettingsManifest({ kind, sources, options, targetIdentity, logicalSourceId, mirrorDatabase,
  admission, batchSize = 100, credentialPlanPath = null }) {
  exactKeys(targetIdentity, ['serverUuid', 'database', 'storageMode', 'schemaHash'])
  exactKeys(options, kind === 'credential'
    ? ['run', 'basis', 'evidenceCatalog', 'credentialPlan', 'credentialKeyring', 'expectedPlanChecksum']
    : ['run', 'basis', 'evidenceCatalog'])
  check(options.evidenceCatalog instanceof Map && options.evidenceCatalog.size > 0 && options.evidenceCatalog.size <= 1000, 'settings_manifest_evidence')
  for (const [id, digest] of options.evidenceCatalog) check(typeof id === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(id)
    && typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest), 'settings_manifest_evidence')
  check(kind === 'credential' ? typeof credentialPlanPath === 'string' && credentialPlanPath.length > 0
    : credentialPlanPath === null, 'settings_manifest_plan_path')
  const recipe = (kind === 'credential' ? createCredentialSettingsBackfill : createSettingsBackfill)(sources, options, { batchSize })
  const manifest = {
    kind, sourceIds: sources.map(source => source.id).sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1),
    options: { run: structuredClone(options.run), basis: structuredClone(options.basis),
      evidenceCatalog: [...options.evidenceCatalog].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0),
      ...(kind === 'credential' ? { expectedPlanChecksum: options.expectedPlanChecksum } : {}) },
    spec: { runId: recipe.runId, admission: structuredClone(admission), bindings: {
      logicalSourceId, sourceDatabase: targetIdentity.database, mirrorDatabase,
      targetServerUuid: targetIdentity.serverUuid, targetDatabase: targetIdentity.database,
      schemaHash: targetIdentity.schemaHash, storageMode: targetIdentity.storageMode,
      snapshotHash: recipe.sourceHash, transformHash: recipe.transformHash,
      manifestHash: '0'.repeat(64), streams: [recipe.stream],
    } }, batchSize, credentialPlanPath,
  }
  manifest.spec.bindings.manifestHash = settingsMigrationManifestHash(manifest)
  createSettingsMigration({ kind, sources, options, spec: manifest.spec, batchSize })
  return manifest
}

// Caller-owned private path, exclusive creation. Repeating an identical reviewed
// manifest is safe; existing conflicting or partial files are never overwritten.
export async function persistSettingsManifest(path, manifest) {
  check(manifest.spec?.bindings?.manifestHash === settingsMigrationManifestHash(manifest), 'settings_manifest_hash')
  let file
  try { file = await open(path, 'wx', 0o600) }
  catch (error) { if (error.code !== 'EEXIST') throw new Error('settings_manifest_create_failed') }
  if (file) {
    try { await file.writeFile(JSON.stringify(manifest, null, 2) + '\n'); await file.sync() }
    catch { throw new Error('settings_manifest_write_unknown') }
    finally { await file.close() }
  }
  let saved
  try { saved = JSON.parse(await readFile(path, 'utf8')) }
  catch { throw new Error('settings_manifest_file_invalid') }
  check(canonical(saved) === canonical(manifest), 'settings_manifest_file_conflict')
  return saved
}
