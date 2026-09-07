import { canonical, hash, requireBackfill as check } from './v4-backfill-contract.mjs'
import { validateSpec } from './v4-settings-backfill-contract.mjs'
import { createSettingsBackfill } from './v4-settings-backfill.mjs'
import { createCredentialSettingsBackfill } from './v4-settings-credential-backfill.mjs'
import { settingsValueContracts } from './v4-settings-value-contract.mjs'
import { prepareBackfillRun, executeBackfillBatch, recoverBackfillBatch } from './v4-settings-backfill-runner.mjs'
import { auditSettingsImport, settingsAuditFields } from './v4-settings-audit.mjs'
import { auditCredentialSettingsImport } from './v4-settings-credential-audit.mjs'

const rules = new Map(settingsValueContracts().map(rule => [`${rule.namespace}/${rule.key}`, rule]))
const sourceProjection = "CAST(id AS CHAR) id,category,`key`,value,label,CAST(sort_order AS CHAR) sort_order,created_at,updated_at"
const integerFields = ['id', 'sort_order', 'revision']
const targetProjection = settingsAuditFields.map(field => integerFields.includes(field) ? `CAST(${field} AS CHAR) ${field}`
  : field.endsWith('_at_utc') ? `DATE_FORMAT(${field},'%Y-%m-%d %H:%i:%s.%f') ${field}` : field).join(',')
const decode = value => typeof value === 'string' ? JSON.parse(value) : value

export function settingsMigrationManifestHash(manifest) {
  return hash({ ...manifest, spec: { ...manifest.spec, bindings: { ...manifest.spec.bindings, manifestHash: null } } })
}

// One immutable run handles either ordinary settings or protected credentials.
// Distinct runs prevent one role/checkpoint from silently changing semantics.
export function createSettingsMigration({ kind, sources, options, spec, batchSize = 100 }) {
  check(['ordinary', 'credential'].includes(kind), 'settings_migration_kind')
  validateSpec(spec)
  check(Array.isArray(sources) && sources.length > 0 && sources.every(source => {
    const rule = rules.get(`${source.category}/${source.key}`)
    return rule && (rule.type === 'credential') === (kind === 'credential')
  }), 'settings_migration_source_scope')
  const frozenSpec = structuredClone(spec)
  const frozenOptions = { ...structuredClone({ ...options, credentialKeyring: undefined }), credentialKeyring: options.credentialKeyring }
  const recipe = (kind === 'credential' ? createCredentialSettingsBackfill : createSettingsBackfill)(sources, frozenOptions, { batchSize })
  check(recipe.runId === spec.runId && recipe.sourceHash === spec.bindings.snapshotHash
    && recipe.transformHash === spec.bindings.transformHash && canonical([recipe.stream]) === canonical(spec.bindings.streams), 'settings_migration_recipe_binding')
  const sourceIds = sources.map(source => source.id)
  const audit = kind === 'credential' ? auditCredentialSettingsImport : auditSettingsImport
  async function verify(repository) {
    return repository.transaction(async tx => {
      const identity = await tx.targetIdentity()
      check(identity.database === frozenSpec.bindings.targetDatabase && identity.serverUuid === frozenSpec.bindings.targetServerUuid
        && identity.schemaHash === frozenSpec.bindings.schemaHash && identity.storageMode === frozenSpec.bindings.storageMode, 'settings_migration_target_drift')
      const run = await tx.findRun(frozenSpec.runId)
      check(run?.bindingsHash === hash(frozenSpec.bindings) && canonical(run.bindings) === canonical(frozenSpec.bindings), 'settings_migration_run_binding')
      const [sourceRows] = await tx.connection.execute(`SELECT ${sourceProjection} FROM system_config WHERE id IN (${sourceIds.map(() => '?').join(',')}) ORDER BY id FOR UPDATE`, sourceIds)
      const [targets] = await tx.connection.execute(`SELECT ${targetProjection} FROM system_settings WHERE migration_run_id=? ORDER BY id FOR UPDATE`, [recipe.runId])
      const [saved] = await tx.connection.execute('SELECT source_pk_sha256,source_bytes_sha256,source_payload_json FROM data_migration_source_rows WHERE run_id=? FOR UPDATE', [recipe.runId])
      const archives = saved.map(row => {
        const payload = decode(row.source_payload_json)
        return { sourceId: payload.source.id, runId: recipe.runId, sourceHash: row.source_bytes_sha256, sourcePkHash: row.source_pk_sha256, payload }
      })
      const result = audit(sourceRows.map(row => ({ ...row })), targets.map(row => ({ ...row })), archives, frozenOptions)
      check(result.importMatchesReviewedInputs, 'settings_migration_audit_failed')
      return result
    })
  }
  return {
    sourceEvidence: recipe.sourceEvidence,
    summary: { kind, runId: recipe.runId, sourceRows: recipe.sourceRows, batches: recipe.batches.length, transformHash: recipe.transformHash },
    async run(mode, repository) {
      check(['apply', 'recover', 'verify'].includes(mode), 'settings_migration_mode')
      if (mode === 'apply') {
        await prepareBackfillRun(repository, frozenSpec)
        for (const batch of recipe.batches) await executeBackfillBatch(repository, frozenSpec, batch, recipe.writer)
      } else if (mode === 'recover') {
        for (const batch of recipe.batches) {
          const recovered = await recoverBackfillBatch(repository, frozenSpec, batch)
          if (recovered.status !== 'committed') return { status: recovered.status, runId: recipe.runId, batchId: batch.batchId }
        }
      }
      return { status: 'verified', runId: recipe.runId, audit: await verify(repository) }
    },
  }
}
