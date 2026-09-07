import { readFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { loadSettingsMigrationEnvironment, settingsMigrationConnectionOptions } from './lib/settings-migration-environment.mjs'
import mysql from 'mysql2/promise'
import { createHash } from 'node:crypto'
import { exactKeys, requireBackfill as check } from './lib/v4-backfill-contract.mjs'
import { persistCredentialPlan } from './lib/v4-settings-credential-plan.mjs'
import { createSettingsMigration, settingsMigrationManifestHash } from './lib/v4-settings-migration.mjs'
import { MysqlSettingsBackfillRepositoryV3, readSettingsTargetIdentityV3 } from './lib/mysql-settings-backfill-v3.mjs'
import { withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'

const root = new URL('../', import.meta.url)
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
let pool, connection
const keyring = new Map()
try {
  const [flag, input] = process.argv.slice(2)
  if (flag === '--help' && !input) {
    console.log('node scripts/migrate-dev-vue-settings.mjs --check|--apply|--recover|--verify <reviewed-manifest.json>')
  } else {
    check(process.argv.length === 4 && ['--check', '--apply', '--recover', '--verify'].includes(flag), 'settings_entry_arguments')
    const manifest = await json(resolve(input))
    exactKeys(manifest, ['kind', 'sourceIds', 'options', 'spec', 'batchSize', 'credentialPlanPath'])
    check(manifest.spec.bindings.manifestHash === settingsMigrationManifestHash(manifest), 'settings_entry_manifest_hash')
    check(Array.isArray(manifest.sourceIds) && manifest.sourceIds.length > 0 && manifest.sourceIds.length <= 59
      && manifest.sourceIds.every(id => typeof id === 'string' && /^[1-9][0-9]{0,9}$/.test(id))
      && new Set(manifest.sourceIds).size === manifest.sourceIds.length, 'settings_entry_source_ids')
    const proofRaw = await readFile(new URL('docs/migration/dev-vue-settings-unified-backfill-rehearsal-20260907.json', root))
    check(sha(proofRaw) === 'f436e76d1363ef4157d6567cd85db5ed5f8020179a715e9b55f0396bc9ec312b', 'settings_entry_proof_changed')
    const proof = JSON.parse(proofRaw)
    check(proof.kind === 'settings-unified-backfill-probe/v1' && proof.partialRecoveryDidNotWrite && proof.fullRecoveryVerified && proof.unifiedAuditVerified && proof.persistedPlanRecovered
      && proof.commitUnknownObserved && proof.sourceEvidenceFailureRolledBack && proof.repeatNoop
      && proof.audit.importMatchesReviewedInputs && proof.audit.differences.length === 0, 'settings_entry_proof_invalid')
    for (const file of proof.toolManifest) {
      check(/^[a-zA-Z0-9_./-]+$/.test(file.path) && !file.path.split('/').includes('..')
        && sha(await readFile(new URL(file.path, root))) === file.sha256, 'settings_entry_proof_tools')
    }
    const env = await loadSettingsMigrationEnvironment(root)
    check(manifest.spec.bindings.targetDatabase === env.MYSQL_DATABASE, 'settings_entry_database')
    const options = manifest.options
    check(Array.isArray(options.evidenceCatalog), 'settings_entry_evidence')
    options.evidenceCatalog = new Map(options.evidenceCatalog)
    if (manifest.kind === 'credential') {
      check(typeof options.expectedPlanChecksum === 'string' && /^[a-f0-9]{64}$/.test(options.expectedPlanChecksum)
        && typeof manifest.credentialPlanPath === 'string', 'settings_entry_plan_required')
      const keys = JSON.parse(env.AI_CREDENTIAL_KEYS_JSON || '{}')
      check(keys && typeof keys === 'object' && !Array.isArray(keys), 'settings_entry_keys')
      for (const [version, encoded] of Object.entries(keys)) {
        check(typeof encoded === 'string', 'settings_entry_keys')
        const key = Buffer.from(encoded, 'base64')
        check(key.length === 32 && key.toString('base64') === encoded, 'settings_entry_keys')
        keyring.set(version, key)
      }
    } else check(manifest.credentialPlanPath === null, 'settings_entry_plan_scope')
    pool = mysql.createPool({ ...settingsMigrationConnectionOptions(env), connectionLimit: 3 })
    connection = await pool.getConnection()
    await connection.query("SET SESSION time_zone='+00:00'")
    const result = await withInplaceUpgradeLock(connection, env.MYSQL_DATABASE, async () => {
      const identity = await readSettingsTargetIdentityV3(connection)
      const backup = await json(new URL('docs/migration/dev-vue-inplace-backup-20260906.json', root))
      check(identity.serverUuid === backup.serverUuid && identity.serverUuid === manifest.spec.bindings.targetServerUuid
        && identity.schemaHash === manifest.spec.bindings.schemaHash, 'settings_entry_identity')
      const [rows] = await connection.execute(`SELECT CAST(id AS CHAR) id,category,\`key\`,value,label,CAST(sort_order AS CHAR) sort_order,created_at,updated_at FROM system_config WHERE id IN (${manifest.sourceIds.map(() => '?').join(',')}) ORDER BY id`, manifest.sourceIds)
      check(rows.length === manifest.sourceIds.length, 'settings_entry_source_missing')
      const sources = rows.map(row => ({ ...row }))
      if (manifest.kind === 'credential') {
        options.credentialKeyring = keyring
        options.credentialPlan = await persistCredentialPlan(resolve(dirname(resolve(input)), manifest.credentialPlanPath), sources.map(row => ({
          sourceId: row.id, namespace: row.category, key: row.key, sourceRowHash: options.basis.resolutions.find(item => item.sourceId === row.id)?.sourceHash,
          sourceFormat: options.basis.resolutions.find(item => item.sourceId === row.id)?.sourceFormat, value: row.value,
        })), { runId: options.run.id, snapshotHash: manifest.spec.bindings.snapshotHash }, { keyring, expectedChecksum: options.expectedPlanChecksum })
      }
      const migration = createSettingsMigration({ ...manifest, sources, options })
      if (flag === '--check') return { status: 'checked', ...migration.summary, databaseWrites: 0 }
      const repository = new MysqlSettingsBackfillRepositoryV3(pool, migration.sourceEvidence)
      return migration.run(flag.slice(2), repository)
    })
    console.log(JSON.stringify(result))
    if (result.status === 'unknown' || result.status === 'not_committed') process.exitCode = 2
  }
} catch (error) {
  console.error(JSON.stringify({ code: /^(settings|credential|backfill|inplace)_[a-z_]+$/.test(error.message) ? error.message : 'settings_entry_failed' }))
  process.exitCode = 1
} finally {
  for (const key of keyring.values()) key.fill(0)
  connection?.release()
  await pool?.end()
}
