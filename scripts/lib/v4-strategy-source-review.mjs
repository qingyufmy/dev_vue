import { hash } from './v4-backfill-contract.mjs'
import { createHash } from 'node:crypto'

export const legacyStrategyFields = Object.freeze(['id', 'title', 'description', 'system_prompt', 'symbols_json', 'interval_minutes', 'is_active', 'sort_order', 'created_by', 'created_at', 'updated_at', 'deleted_at', 'scope', 'owner_user_id', 'model_profile_id', 'inference_mode', 'visibility_status', 'version', 'version_label', 'market_data_plan_json', 'strategy_policy_json', 'entry_methods_json', 'use_chan_analysis', 'use_ema34_filter', 'include_portfolio_context'])
export const legacySubscriptionFields = Object.freeze(['id', 'user_id', 'trading_account_id', 'strategy_id', 'risk_profile_id', 'symbols_json', 'execution_enabled', 'memory_mode', 'conflicting_strategy_id', 'is_deleted', 'created_at', 'updated_at', 'schedule_enabled', 'schedule_timezone', 'schedule_weekdays_json', 'schedule_windows_json', 'outside_window_behavior', 'take_profit_mode', 'active_execution_user_key'])
const positive = value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value)
const boolean = value => value === '0' || value === '1'

export function reviewStrategySources({ strategies, subscriptions, userIds, accountIds }) {
  const issues = [], strategyIds = new Set(), subscriptionIds = new Set()
  const issue = (table, id, code, field) => issues.push({ table, locatorHash: hash(String(id)), code, field })
  const validate = (table, rows, fields, ids) => {
    for (const row of rows) {
      if (Object.keys(row).length !== fields.length || fields.some(field => !Object.hasOwn(row, field))
        || Object.values(row).some(value => value !== null && typeof value !== 'string')) throw new Error('strategy_source_shape_invalid')
      if (!positive(row.id) || ids.has(row.id)) throw new Error('strategy_source_identity_invalid')
      ids.add(row.id)
    }
  }
  validate('auto_prompt_types', strategies, legacyStrategyFields, strategyIds)
  validate('strategy_subscriptions', subscriptions, legacySubscriptionFields, subscriptionIds)
  const json = (table, row, field, expected, nullable = false) => {
    if (row[field] === null && nullable) return null
    try {
      const value = JSON.parse(row[field])
      if (expected === 'array' ? !Array.isArray(value) : !value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
      return value
    } catch { issue(table, row.id, 'invalid_json_shape', field); return null }
  }
  const perStrategy = strategies.map(row => {
    const table = 'auto_prompt_types'
    if (!['platform', 'private'].includes(row.scope)) issue(table, row.id, 'unknown_scope', 'scope')
    if (row.scope === 'private' && !userIds.has(row.owner_user_id)) issue(table, row.id, 'owner_missing', 'owner_user_id')
    if (row.scope === 'platform' && ![null, '0'].includes(row.owner_user_id)) issue(table, row.id, 'platform_owner_conflict', 'owner_user_id')
    if (!userIds.has(row.created_by)) issue(table, row.id, 'creator_missing', 'created_by')
    for (const field of ['is_active', 'use_chan_analysis', 'use_ema34_filter', 'include_portfolio_context']) if (!boolean(row[field])) issue(table, row.id, 'invalid_boolean', field)
    if (!positive(row.version)) issue(table, row.id, 'invalid_version', 'version')
    if (row.description === null || [...row.description].length > 2000) issue(table, row.id, 'description_target_incompatible', 'description')
    if (!row.system_prompt?.trim()) issue(table, row.id, 'empty_prompt', 'system_prompt')
    if (!['active', 'archived', 'draft'].includes(row.visibility_status)) issue(table, row.id, 'visibility_mapping_required', 'visibility_status')
    const symbols = json(table, row, 'symbols_json', 'array')
    const market = json(table, row, 'market_data_plan_json', 'object', true)
    const policy = json(table, row, 'strategy_policy_json', 'object', true)
    json(table, row, 'entry_methods_json', 'array', true)
    if (symbols && symbols.some(value => typeof value !== 'string' || !value)) issue(table, row.id, 'invalid_symbol', 'symbols_json')
    return { locatorHash: hash(row.id), sourceHash: hash(row), promptHash: row.system_prompt === null ? null : createHash('sha256').update(row.system_prompt, 'utf8').digest('hex'),
      promptBytes: Buffer.byteLength(row.system_prompt ?? '', 'utf8'), descriptionCharacters: row.description === null ? null : [...row.description].length,
      scope: row.scope, visibilityStatus: row.visibility_status, isActive: row.is_active, deleted: row.deleted_at !== null,
      currentVersion: row.version, inferenceMode: row.inference_mode, symbolCount: symbols?.length ?? null,
      marketConfigKeys: market ? Object.keys(market).sort() : null, policyConfigKeys: policy ? Object.keys(policy).sort() : null,
      targetKind: null, historicalVersionsReconstructed: false }
  })
  let symbolOccurrences = 0
  const strategyById = new Map(strategies.map(row => [row.id, row]))
  const perSubscription = subscriptions.map(row => {
    const table = 'strategy_subscriptions'
    if (!strategyIds.has(row.strategy_id)) issue(table, row.id, 'strategy_missing', 'strategy_id')
    if (!userIds.has(row.user_id)) issue(table, row.id, 'user_missing', 'user_id')
    if (!accountIds.has(row.trading_account_id)) issue(table, row.id, 'account_missing', 'trading_account_id')
    for (const field of ['execution_enabled', 'is_deleted', 'schedule_enabled']) if (!boolean(row[field])) issue(table, row.id, 'invalid_boolean', field)
    const inherited = row.symbols_json === null
    const parent = strategyById.get(row.strategy_id)
    const symbols = inherited ? (parent ? json('auto_prompt_types', parent, 'symbols_json', 'array') : null) : json(table, row, 'symbols_json', 'array')
    if (symbols) {
      symbolOccurrences += symbols.length
      if (symbols.some(value => typeof value !== 'string' || !value) || new Set(symbols).size !== symbols.length) issue(table, row.id, 'invalid_or_duplicate_symbols', 'symbols_json')
    }
    json(table, row, 'schedule_weekdays_json', 'array', true)
    json(table, row, 'schedule_windows_json', 'array', true)
    return { locatorHash: hash(row.id), sourceHash: hash(row), strategyLocatorHash: hash(row.strategy_id),
      symbolCount: symbols?.length ?? null, symbolSource: inherited ? 'strategy_inherited' : 'subscription_explicit',
      symbolSourceHash: hash(inherited ? parent?.symbols_json ?? null : row.symbols_json),
      executionEnabled: row.execution_enabled, deleted: row.is_deleted, scheduleEnabled: row.schedule_enabled }
  })
  return { kind: 'legacy_strategy_source_review', sourceHash: hash({ strategies, subscriptions }),
    counts: { strategies: strategies.length, subscriptions: subscriptions.length, sourceFields: legacyStrategyFields.length + legacySubscriptionFields.length, subscriptionSymbolOccurrences: symbolOccurrences },
    fields: { auto_prompt_types: legacyStrategyFields, strategy_subscriptions: legacySubscriptionFields }, perStrategy, perSubscription, issues,
    blockers: ['strategy_kind_and_output_contract_mapping', 'configuration_field_conversion', 'historical_time_basis', 'subscription_account_symbol_permissions', 'historical_version_evidence'],
    executable: false, businessWritesPerformed: false }
}
