import { createHash } from 'node:crypto'
import { hash } from './v4-backfill-contract.mjs'

export const strategyMetadataFields = Object.freeze(['id', 'title', 'description', 'system_prompt', 'scope', 'owner_user_id', 'created_by',
  'is_active', 'visibility_status', 'version', 'created_at', 'updated_at', 'deleted_at'])

// Exact source values become a partial candidate. kind/config/time require their
// own proven mappings before this can be written as a runnable V4 strategy.
export function convertStrategyMetadata(row, userIds) {
  const source = Object.fromEntries(strategyMetadataFields.map(field => [field, row[field]]))
  if (Object.values(source).some(value => value !== null && typeof value !== 'string')) throw new Error('strategy_metadata_source_shape')
  const problems = [], issue = (field, code) => problems.push({ field, code })
  const id = (value, max) => typeof value === 'string' && /^[1-9]\d*$/.test(value) && BigInt(value) <= max
  if (!id(source.id, 18446744073709551615n)) issue('id', 'strategy_source_id_invalid')
  for (const [field, limit] of [['title', 191], ['description', 2000]]) {
    if (source[field] === null || [...source[field]].length > limit || (field === 'title' && !source[field].trim())) issue(field, 'strategy_metadata_target_text_invalid')
  }
  if (!source.system_prompt?.trim()) issue('system_prompt', 'strategy_prompt_missing')
  if (!id(source.version, 4294967295n)) issue('version', 'strategy_version_out_of_range')
  if (!id(source.created_by, 2147483647n) || !userIds.has(source.created_by)) issue('created_by', 'strategy_creator_missing')
  let scope = null, ownerUserId = null
  if (source.scope === 'platform') {
    scope = 'platform'
    if (source.owner_user_id !== null && source.owner_user_id !== '0') issue('owner_user_id', 'strategy_platform_owner_conflict')
  } else if (source.scope === 'private') {
    scope = 'user'; ownerUserId = source.owner_user_id
    if (!id(ownerUserId, 2147483647n) || !userIds.has(ownerUserId)) issue('owner_user_id', 'strategy_owner_missing')
  } else issue('scope', 'strategy_scope_unknown')
  let status = null
  if (!['0', '1'].includes(source.is_active) || !['active', 'draft', 'archived'].includes(source.visibility_status)) issue('visibility_status', 'strategy_lifecycle_unknown')
  else if (source.deleted_at !== null || source.visibility_status === 'archived') status = 'retired'
  else if (source.is_active === '1' && source.visibility_status === 'active') status = 'active'
  else if (source.is_active === '0' && source.visibility_status === 'draft') status = 'draft'
  else issue('is_active', 'strategy_lifecycle_mapping_required')
  const promptHash = source.system_prompt === null ? null : createHash('sha256').update(source.system_prompt, 'utf8').digest('hex')
  return { sourceHash: hash(source), status: problems.length ? 'blocked' : 'converted', problems,
    candidate: problems.length ? null : { legacySourceTable: 'auto_prompt_types', legacyId: source.id, name: source.title, description: source.description,
      scope, ownerUserId, status, currentVersionNumber: source.version, createdByUserId: source.created_by, promptHash,
      promptBytes: Buffer.byteLength(source.system_prompt, 'utf8') },
    timeSourceHash: hash({ created_at: source.created_at, updated_at: source.updated_at, deleted_at: source.deleted_at }),
    executable: false, historicalVersionsReconstructed: false,
    blockers: ['strategy_role_and_output_contract', 'strategy_configuration_conversion', 'historical_time_basis'] }
}
