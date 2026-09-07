import { readFile } from 'node:fs/promises'
import { resolve, dirname, relative } from 'node:path'
import { loadSettingsMigrationEnvironment, settingsMigrationConnectionOptions } from './lib/settings-migration-environment.mjs'
import mysql from 'mysql2/promise'
import { exactKeys, requireBackfill as check } from './lib/v4-backfill-contract.mjs'
import { readSettingsTargetIdentityV3 } from './lib/mysql-settings-backfill-v3.mjs'
import { buildSettingsManifest, persistSettingsManifest } from './lib/v4-settings-manifest.mjs'

const root = new URL('../', import.meta.url)
const json = async path => JSON.parse(await readFile(path, 'utf8'))
let connection
const keyring = new Map()
try {
  const [flag, input, output] = process.argv.slice(2)
  if (flag === '--help' && !input && !output) console.log('node scripts/prepare-dev-vue-settings.mjs --write <reviewed-basis.json> <manifest.json>')
  else {
    check(process.argv.length === 5 && flag === '--write', 'settings_prepare_arguments')
    const review = await json(resolve(input))
    exactKeys(review, ['kind', 'sourceIds', 'options', 'logicalSourceId', 'mirrorDatabase', 'admission', 'batchSize', 'credentialPlanPath'])
    check(Array.isArray(review.sourceIds) && review.sourceIds.length > 0 && review.sourceIds.length <= 59
      && review.sourceIds.every(id => typeof id === 'string' && /^[1-9][0-9]{0,9}$/.test(id))
      && new Set(review.sourceIds).size === review.sourceIds.length, 'settings_prepare_source_ids')
    check(['ordinary', 'credential'].includes(review.kind) && Array.isArray(review.options.evidenceCatalog), 'settings_prepare_kind')
    const env = await loadSettingsMigrationEnvironment(root)
    const options = review.options
    options.evidenceCatalog = new Map(options.evidenceCatalog)
    let credentialPlanPath = null
    if (review.kind === 'credential') {
      check(typeof review.credentialPlanPath === 'string' && review.credentialPlanPath.length > 0, 'settings_prepare_plan')
      const absolute = resolve(dirname(resolve(input)), review.credentialPlanPath)
      options.credentialPlan = await json(absolute)
      credentialPlanPath = relative(dirname(resolve(output)), absolute)
      const parsed = JSON.parse(env.AI_CREDENTIAL_KEYS_JSON || '{}')
      check(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'settings_prepare_keys')
      for (const [version, encoded] of Object.entries(parsed)) {
        check(typeof encoded === 'string', 'settings_prepare_keys')
        const key = Buffer.from(encoded, 'base64')
        check(key.length === 32 && key.toString('base64') === encoded, 'settings_prepare_keys')
        keyring.set(version, key)
      }
      options.credentialKeyring = keyring
    } else check(review.credentialPlanPath === null, 'settings_prepare_plan_scope')
    connection = await mysql.createConnection(settingsMigrationConnectionOptions(env))
    await connection.query("SET SESSION time_zone='+00:00'")
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
    const targetIdentity = await readSettingsTargetIdentityV3(connection)
    const backup = await json(new URL('docs/migration/dev-vue-inplace-backup-20260906.json', root))
    check(targetIdentity.serverUuid === backup.serverUuid, 'settings_prepare_identity')
    const [rows] = await connection.execute(`SELECT CAST(id AS CHAR) id,category,\`key\`,value,label,CAST(sort_order AS CHAR) sort_order,created_at,updated_at FROM system_config WHERE id IN (${review.sourceIds.map(() => '?').join(',')}) ORDER BY id`, review.sourceIds)
    check(rows.length === review.sourceIds.length, 'settings_prepare_source_missing')
    const manifest = buildSettingsManifest({ ...review, sources: rows.map(row => ({ ...row })), options, targetIdentity, credentialPlanPath })
    await connection.rollback()
    await persistSettingsManifest(resolve(output), manifest)
    console.log(JSON.stringify({ status: 'prepared', kind: manifest.kind, runId: manifest.spec.runId,
      sourceRows: manifest.sourceIds.length, manifestHash: manifest.spec.bindings.manifestHash, databaseWrites: 0 }))
  }
} catch (error) {
  console.error(JSON.stringify({ code: /^(settings|credential|backfill|inplace)_[a-z_]+$/.test(error.message) ? error.message : 'settings_prepare_failed' }))
  process.exitCode = 1
} finally {
  for (const key of keyring.values()) key.fill(0)
  if (connection) { await connection.rollback().catch(() => {}); await connection.end().catch(() => {}) }
}
