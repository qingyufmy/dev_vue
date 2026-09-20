import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { hash } from './v4-backfill-contract.mjs'
import { convertStrategyMetadata } from './v4-strategy-metadata-conversion.mjs'
import { convertStrategyRoleConfig } from './v4-strategy-role-config-conversion.mjs'
import { convertSubscriptionSymbols } from './v4-subscription-symbol-conversion.mjs'
import { convertSubscriptionSchedule } from './v4-subscription-schedule-conversion.mjs'
import { convertSubscriptionExecutionPreferences } from './v4-subscription-preferences-conversion.mjs'
import { strategyRoleLegacyIdentity } from './strategy-role-legacy-identity.mjs'
import { subscriptionLegacyIdentity } from './subscription-legacy-identity.mjs'
import { inspectWallClock } from './v4-identity-time.mjs'
import { compileStrategy } from '../../server/dist-v4/modules/strategies/application/strategy-service.js'

const sha = value => createHash('sha256').update(value).digest('hex')
const utc = value => inspectWallClock(value).canonicalWallClock

// Frozen, non-executable data admission. Originals remain in each batch archive.
// No implicit activation or reconstruction of unavailable historical versions.
export function projectStrategySubscriptionTransition({ strategies, subscriptions, users, accountMap, ownerships, intervals, maxima, roleCandidates }) {
  const counters = Object.fromEntries(Object.entries(maxima).map(([key, value]) => {
    assert.match(value, /^(0|[1-9]\d*)$/)
    return [key, BigInt(value)]
  }))
  const next = key => {
    counters[key]++
    assert.ok(counters[key] <= 18446744073709551615n)
    return String(counters[key])
  }
  const admissions = []
  const strategyEntries = strategies.map(source => {
    const metadata = convertStrategyMetadata(source, new Set(users.map(row => row.id)))
    assert.equal(metadata.status, 'converted', 'transition_metadata_unresolved')
    const saved = roleCandidates.find(row => row.sourceId === source.id)
    assert.ok(saved && saved.originalTextFullyAssigned && saved.executable === false)
    assert.equal(saved.sourceHash, hash(source), 'transition_role_source_changed')
    assert.equal(saved.sourceVersion, source.version)
    assert.equal(saved.sourcePromptHash, sha(source.system_prompt))
    const config = convertStrategyRoleConfig(source), roles = {}
    for (const kind of ['analysis', 'trader']) {
      const prompt = saved.roles[kind], compiled = compileStrategy(kind, prompt.promptText, config[`${kind}Config`])
      assert.equal(sha(prompt.promptText), prompt.promptHash, 'transition_role_prompt_changed')
      assert.ok(compiled.valid, 'transition_compile_failed')
      assert.equal(compiled.promptHash, prompt.promptHash)
      const identity = strategyRoleLegacyIdentity(source.id, source.version, kind)
      const id = next('strategies'), versionId = next('strategy_versions'), meta = metadata.candidate
      roles[kind] = {
        strategy: { id, kind, scope: meta.scope, owner_user_id: meta.ownerUserId, name: meta.name, description: meta.description,
          status: meta.status === 'retired' ? 'retired' : 'draft', active_version_id: null, revision: '1',
          legacy_source_table: identity.strategy.legacySourceTable, legacy_id: identity.strategy.legacyId,
          created_at_utc: utc(source.created_at), updated_at_utc: utc(source.updated_at), deleted_at_utc: utc(source.deleted_at) },
        version: { id: versionId, strategy_id: id, version_number: source.version, prompt_text: prompt.promptText,
          prompt_sha256: compiled.promptHash, input_contract_version: compiled.inputContractVersion,
          output_contract_version: compiled.outputContractVersion, config_json: compiled.normalizedConfig,
          created_by_user_id: meta.createdByUserId, legacy_source_table: identity.version.legacySourceTable,
          legacy_id: identity.version.legacyId, created_at_utc: utc(source.updated_at) },
      }
    }
    admissions.push({ sourceId: source.id, sourceHash: hash(source), originalStatus: metadata.candidate.status,
      targetStatus: roles.analysis.strategy.status, runtimeAdmission: 'blocked', semanticAcceptance: 'pending',
      configStatus: config.status, configProblems: config.problems })
    return { source, sourceHash: hash(source), roles }
  })
  const subscriptionAdmissions = []
  const subscriptionEntries = subscriptions.map(source => {
    const parent = strategyEntries.find(row => row.source.id === source.strategy_id)
    assert.ok(parent, 'transition_parent_missing')
    const accountId = accountMap.find(([legacy]) => legacy === source.trading_account_id)?.[1]
    assert.ok(accountId, 'transition_account_mapping_missing')
    const owns = row => row.userId === source.user_id && row.accountId === accountId
    const current = ownerships.some(owns), historical = intervals.filter(row => owns(row) && row.ended_at_utc !== null)
    assert.ok(current || historical.length > 0, 'transition_ownership_unresolved')
    const symbols = convertSubscriptionSymbols(source.symbols_json, parent.source.symbols_json)
    const schedule = convertSubscriptionSchedule(source), preferences = convertSubscriptionExecutionPreferences(source)
    for (const value of [symbols, schedule, preferences]) assert.equal(value.status, 'converted')
    assert.match(parent.source.interval_minutes, /^[1-9]\d*$/)
    const cadence = Number(parent.source.interval_minutes) * 60
    assert.ok(Number.isSafeInteger(cadence) && cadence >= 60 && cadence <= 4294967295)
    const status = current && source.is_deleted === '0' ? 'paused' : 'ended'
    subscriptionAdmissions.push({ sourceId: source.id, sourceHash: hash(source), targetAccountId: accountId,
      ownershipDisposition: current ? 'current_owner' : 'historical_only', status, runtimePermissionGranted: false })
    const projections = symbols.symbols.map(symbol => {
      const id = next('strategy_subscriptions'), identity = subscriptionLegacyIdentity(source.id, symbol)
      return {
        subscription: { id, user_id: source.user_id, trading_account_id: accountId, standard_symbol: symbol,
          analysis_strategy_id: parent.roles.analysis.strategy.id, analysis_strategy_version_id: parent.roles.analysis.version.id,
          trader_strategy_id: parent.roles.trader.strategy.id, trader_strategy_version_id: parent.roles.trader.version.id,
          analysis_enabled: 0, trader_enabled: 0, trade_send_enabled: 0, status, revision: '1',
          legacy_source_table: identity.sourceTable, legacy_id: identity.legacyId,
          created_at_utc: utc(source.created_at), updated_at_utc: utc(source.updated_at) },
        schedule: { subscription_id: id, cadence_seconds: cadence, receive_timezone: 'terminal_server',
          receive_window_json: schedule.candidate, next_due_at_utc: null, revision: '1', updated_at_utc: utc(source.updated_at) },
        preferences: { subscription_id: id, ...preferences.candidate },
      }
    })
    return { source, sourceHash: hash(source), strategySource: parent.source, strategySourceHash: parent.sourceHash, projections }
  })
  return { kind: 'strategy-subscription-transition/v1', strategyEntries, subscriptionEntries, admissions, subscriptionAdmissions,
    runtimeEnabled: false, timeBasis: 'user-confirmed-legacy-utc' }
}
