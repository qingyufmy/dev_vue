import { hasLegacyUseChanTag, parseLegacyTimeframeTags } from './utils.js'
import { canonicalPolicyJson, compileStrategyPolicy, StrategyPolicyValidationError,
  STRATEGY_POLICY_SCHEMA_VERSION, STRATEGY_POLICY_TIMEFRAMES } from './strategy-policy-compiler.js'
import { calculatePolicyIndicators, INDICATOR_ALGORITHM_VERSION } from './indicator-registry.js'
import { buildPreInferenceWorkflowState } from './strategy-workflow-engine.js'
import { renderStrategyPolicyPrompt } from './strategy-prompt-renderer.js'
import { evaluateStrategyConstraints } from './strategy-constraint-engine.js'
import { CHAN_WINDOW_POLICY_VERSION } from './chan-window-policy.js'
import crypto from 'node:crypto'

export const VALID_TIMEFRAMES = STRATEGY_POLICY_TIMEFRAMES
export const VALID_ENTRY_METHODS = Object.freeze(['market', 'limit', 'stop', 'stop_limit'])
export const DEFAULT_ENTRY_METHODS = Object.freeze([...VALID_ENTRY_METHODS])

const timeframeSet = new Set(VALID_TIMEFRAMES)
const entryMethodSet = new Set(VALID_ENTRY_METHODS)
export const CHAN_SUPPORTED_TIMEFRAMES = Object.freeze(['M5', 'M15', 'H1', 'H4'])
const chanTimeframeSet = new Set(CHAN_SUPPORTED_TIMEFRAMES)
export const STRATEGY_DATA_CAPABILITIES_VERSION = 'strategy-data-capabilities-v1'
export const SIMPLE_EMA34_INDICATOR_ID = 'ema34'

const SIMPLE_EMA34_FIXED = Object.freeze({
  kind:'ema', enabled:true, field:'close', bar_scope:'closed_only', period:34,
  minimum_bars:34, warmup_target_bars:60, evidence_window:5,
})

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return fallback }
}

export function normalizeEntryMethods(value, fallback = DEFAULT_ENTRY_METHODS) {
  const parsed = parseJson(value, value)
  const source = Array.isArray(parsed) ? parsed : fallback
  const methods = [...new Set(source.map(item => String(item || '').trim().toLowerCase()).filter(item => entryMethodSet.has(item)))]
  if (!methods.length) throw new Error('entry_methods_required')
  return methods
}

function promptPlan(prompt, fallbackTimeframe = 'M30', fallbackCount = 100) {
  const tags = parseLegacyTimeframeTags(String(prompt || ''))
  const source = tags.length ? tags.map(tag => ({ timeframe: tag.tf, kline_count: tag.count })) : [
    { timeframe: String(fallbackTimeframe || 'M30').toUpperCase(), kline_count: fallbackCount },
  ]
  return { primary_timeframe: source[0].timeframe, timeframes: source }
}

export function normalizeUseChanAnalysis(value, { prompt = '' } = {}) {
  if (value === undefined || value === null || value === '') return hasLegacyUseChanTag(prompt)
  return value === true || value === 1 || value === '1'
}

export function normalizeUseEma34Filter(value) {
  return value === true || value === 1 || value === '1'
}

export function normalizeMarketDataPlan(value, { prompt = '', fallbackTimeframe = 'M30', fallbackCount = 100 } = {}) {
  const fallback = promptPlan(prompt, fallbackTimeframe, fallbackCount)
  const parsed = parseJson(value, value)
  const rawItems = Array.isArray(parsed?.timeframes) ? parsed.timeframes : fallback.timeframes
  const seen = new Set()
  const timeframes = []
  for (const item of rawItems) {
    const timeframe = String(item?.timeframe || item?.tf || '').trim().toUpperCase()
    if (!timeframeSet.has(timeframe) || seen.has(timeframe)) continue
    const requested = Number(item?.kline_count ?? item?.count ?? fallbackCount)
    const klineCount = Math.min(500, Math.max(10, Number.isFinite(requested) ? Math.trunc(requested) : fallbackCount))
    seen.add(timeframe)
    timeframes.push({ timeframe, kline_count: klineCount })
  }
  if (!timeframes.length) return fallback
  const requestedPrimary = String(parsed?.primary_timeframe || '').trim().toUpperCase()
  const primaryTimeframe = timeframes.some(item => item.timeframe === requestedPrimary)
    ? requestedPrimary : timeframes[0].timeframe
  timeframes.sort((a, b) => a.timeframe === primaryTimeframe ? -1 : b.timeframe === primaryTimeframe ? 1 : 0)
  return { primary_timeframe: primaryTimeframe, timeframes }
}

export function validateChanTimeframes(marketDataPlan, useChanAnalysis) {
  if (!useChanAnalysis) return { valid:true, unsupported:[] }
  const timeframes = (marketDataPlan?.timeframes || []).map(item => String(item?.timeframe || '').trim().toUpperCase())
  const unsupported = [...new Set(timeframes.filter(timeframe => !chanTimeframeSet.has(timeframe)))]
  const supported = [...new Set(timeframes.filter(timeframe => chanTimeframeSet.has(timeframe)))]
  if (!supported.length) {
    const error = new Error('chan_timeframe_unsupported')
    error.code = 'chan_timeframe_unsupported'
    error.timeframes = unsupported
    throw error
  }
  return { valid:true, supported, unsupported }
}

export function buildStrategyDataCapabilitiesCatalog() {
  return {
    version:STRATEGY_DATA_CAPABILITIES_VERSION,
    timeframes:[...VALID_TIMEFRAMES],
    base_market_data:{
      label:'基础行情与技术摘要',
      description:'每个已启用周期提供 K 线、价格区间和基础技术摘要。',
    },
    chan:{
      id:'chan_structure', label:'提供缠论结构数据',
      description:'为已选的支持周期计算并提供原始结构。不会自动决定方向，也不会强制观望或交易。',
      supported_timeframes:[...CHAN_SUPPORTED_TIMEFRAMES],
      technical_path:'strategy_context.timeframes.<周期>.summary.chan',
      writing_template:'【缠论结构用途】\n- 使用周期：{请填写}\n- 用途：{方向判断 / 入场确认 / 风险参考 / 其他，请填写}\n- 有效结构条件：{请填写}\n- 多周期冲突处理：{请填写}',
    },
    indicators:{
      ema34:{
        id:SIMPLE_EMA34_INDICATOR_ID, kind:'ema', label:'提供 EMA34 数据',
        description:'按所选周期的已收盘 K 线计算并提供。不会自动作为开仓过滤条件。',
        supported_timeframes:[...VALID_TIMEFRAMES], field:'close', bar_scope:'closed_only',
        params:{ period:34, minimum_bars:34, warmup_target_bars:60, evidence_window:5 },
        technical_path:'strategy_context.indicators.ema34',
        writing_template:'【EMA34 用途】\n- 使用周期：{请填写}\n- 用途：{趋势过滤 / 入场确认 / 仅作参考 / 其他，请填写}\n- 多头条件：{请填写}\n- 空头条件：{请填写}\n- 不满足条件时：{请填写}',
      },
    },
    portfolio_context:{
      label:'提供持仓与挂单数据', scope:'private',
      description:'仅私有策略可读取当前账户持仓和挂单事实。',
    },
    user_copy:{
      summary_title:'本策略将收到', helper_title:'如何在策略中使用',
      save_label:'保存策略', advanced_label:'高级配置',
    },
  }
}

function parsePolicyObject(value) {
  if (value == null || value === '') return null
  if (typeof value === 'object' && !Array.isArray(value)) return structuredClone(value)
  try {
    const parsed = JSON.parse(String(value))
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('policy_object_required')
    return parsed
  } catch (error) {
    if (error instanceof StrategyPolicyValidationError) throw error
    throw new StrategyPolicyValidationError('policy_json_invalid', '$')
  }
}

function simpleEma34Declaration(timeframe) {
  return {
    id:SIMPLE_EMA34_INDICATOR_ID,
    kind:SIMPLE_EMA34_FIXED.kind,
    enabled:true,
    source:{ timeframe, field:SIMPLE_EMA34_FIXED.field, bar_scope:SIMPLE_EMA34_FIXED.bar_scope },
    params:{
      period:SIMPLE_EMA34_FIXED.period,
      minimum_bars:SIMPLE_EMA34_FIXED.minimum_bars,
      warmup_target_bars:SIMPLE_EMA34_FIXED.warmup_target_bars,
      evidence_window:SIMPLE_EMA34_FIXED.evidence_window,
    },
  }
}

function isSimpleEma34Indicator(indicator) {
  return indicator?.id === SIMPLE_EMA34_INDICATOR_ID
    && String(indicator.kind || '').toLowerCase() === SIMPLE_EMA34_FIXED.kind
    && indicator.enabled !== false
    && String(indicator.source?.field || '').toLowerCase() === SIMPLE_EMA34_FIXED.field
    && String(indicator.source?.bar_scope || '').toLowerCase() === SIMPLE_EMA34_FIXED.bar_scope
    && Number(indicator.params?.period) === SIMPLE_EMA34_FIXED.period
    && Number(indicator.params?.minimum_bars) === SIMPLE_EMA34_FIXED.minimum_bars
    && Number(indicator.params?.warmup_target_bars) === SIMPLE_EMA34_FIXED.warmup_target_bars
    && Number(indicator.params?.evidence_window) === SIMPLE_EMA34_FIXED.evidence_window
}

function isEma34LikeIndicator(indicator) {
  return String(indicator?.kind || '').toLowerCase() === 'ema' && Number(indicator?.params?.period) === 34
}

function policyReferencesIndicator(value, indicatorId, path = '$') {
  if (path.startsWith('$.indicators')) return false
  if (Array.isArray(value)) return value.some((item, index) => policyReferencesIndicator(item, indicatorId, `${path}[${index}]`))
  if (!value || typeof value !== 'object') {
    const reference = String(value || '')
    return reference === `indicators.${indicatorId}` || reference.startsWith(`indicators.${indicatorId}.`)
  }
  return Object.entries(value).some(([key, item]) => policyReferencesIndicator(item, indicatorId, `${path}.${key}`))
}

function minimalDataPolicy() {
  return {
    schema_version:STRATEGY_POLICY_SCHEMA_VERSION,
    mode:'shadow',
    features:[],
    indicators:[],
    workflow:{ stages:[], selectors:[], default_decision:'allow' },
    constraints:[],
    prompt_rules:[],
    ui:{ groups:[], simple_data_capabilities:{ version:STRATEGY_DATA_CAPABILITIES_VERSION, managed_indicator_ids:[SIMPLE_EMA34_INDICATOR_ID] } },
  }
}

function canonicalCompiledPolicyJson(compiled) {
  if (!compiled) return null
  const { policy_hash:ignoredPolicyHash, ...storage } = compiled
  return canonicalPolicyJson(storage)
}

function isEmptyManagedDataPolicy(policy) {
  if (!policy) return true
  const ui = policy.ui || {}
  const uiKeys = Object.keys(ui).filter(key => key !== 'groups' && key !== 'simple_data_capabilities')
  return (policy.features || []).length === 0
    && (policy.indicators || []).length === 0
    && (policy.workflow?.stages || []).length === 0
    && (policy.workflow?.selectors || []).length === 0
    && (policy.constraints || []).length === 0
    && (policy.prompt_rules || []).length === 0
    && (ui.groups || []).length === 0
    && uiKeys.length === 0
}

export function describeSimpleIndicatorCapabilities(strategyPolicyValue, legacyEma34 = false) {
  const policy = parsePolicyObject(strategyPolicyValue)
  const indicators = Array.isArray(policy?.indicators) ? policy.indicators : []
  const ema = indicators.find(item => item?.id === SIMPLE_EMA34_INDICATOR_ID)
  if (!ema) {
    const advanced = indicators.find(isEma34LikeIndicator)
    if (advanced) return { ema34:{ status:'advanced', enabled:true,
      timeframe:String(advanced.source?.timeframe || '').toUpperCase() || null } }
    return { ema34:{ status:legacyEma34 ? 'legacy_unconfigured' : 'disabled', enabled:false, timeframe:null } }
  }
  if (!isSimpleEma34Indicator(ema) || policyReferencesIndicator(policy, SIMPLE_EMA34_INDICATOR_ID)) {
    return { ema34:{ status:'advanced', enabled:true, timeframe:String(ema.source?.timeframe || '').toUpperCase() || null } }
  }
  return { ema34:{ status:'managed', enabled:true, timeframe:String(ema.source.timeframe).toUpperCase() } }
}

export function mergeSimpleIndicatorDeclarations({ strategyPolicyValue = null, declarations, marketDataPlan,
  confirmEnableDataRuntime = false } = {}) {
  if (declarations === undefined) {
    const policy = parsePolicyObject(strategyPolicyValue)
    const compiled = policy ? compileStrategyPolicy(policy, { marketDataPlan }) : null
    return {
      strategyPolicyJson:canonicalCompiledPolicyJson(compiled),
      useEma34Filter:Boolean((compiled?.indicators || []).some(item => item?.id === SIMPLE_EMA34_INDICATOR_ID && isSimpleEma34Indicator(item))),
      capabilityState:describeSimpleIndicatorCapabilities(compiled, false),
    }
  }
  if (!Array.isArray(declarations)) throw new Error('indicator_declarations_invalid')
  if (declarations.some(item => item?.id !== SIMPLE_EMA34_INDICATOR_ID)) throw new Error('indicator_declaration_unsupported')
  if (declarations.length > 1) throw new Error('indicator_declaration_duplicate')

  let policy = parsePolicyObject(strategyPolicyValue)
  const advancedAlias = (policy?.indicators || []).find(item => item?.id !== SIMPLE_EMA34_INDICATOR_ID && isEma34LikeIndicator(item))
  if (advancedAlias) throw new Error('strategy_indicator_advanced_configuration')
  const existing = (policy?.indicators || []).find(item => item?.id === SIMPLE_EMA34_INDICATOR_ID)
  if (existing && (!isSimpleEma34Indicator(existing) || policyReferencesIndicator(policy, SIMPLE_EMA34_INDICATOR_ID))) {
    throw new Error('strategy_indicator_advanced_configuration')
  }

  const requested = declarations[0] || null
  if (requested) {
    const requestedShapeValid = requested && typeof requested === 'object' && !Array.isArray(requested)
      && requested.enabled !== false
      && (requested.kind === undefined || String(requested.kind).toLowerCase() === SIMPLE_EMA34_FIXED.kind)
      && (requested.source?.field === undefined || String(requested.source.field).toLowerCase() === SIMPLE_EMA34_FIXED.field)
      && (requested.source?.bar_scope === undefined || String(requested.source.bar_scope).toLowerCase() === SIMPLE_EMA34_FIXED.bar_scope)
      && (requested.params?.period === undefined || Number(requested.params.period) === SIMPLE_EMA34_FIXED.period)
      && (requested.params?.minimum_bars === undefined || Number(requested.params.minimum_bars) === SIMPLE_EMA34_FIXED.minimum_bars)
      && (requested.params?.warmup_target_bars === undefined || Number(requested.params.warmup_target_bars) === SIMPLE_EMA34_FIXED.warmup_target_bars)
      && (requested.params?.evidence_window === undefined || Number(requested.params.evidence_window) === SIMPLE_EMA34_FIXED.evidence_window)
    if (!requestedShapeValid) throw new Error('ema34_declaration_invalid')
    const timeframe = String(requested.source?.timeframe || '').trim().toUpperCase()
    const planned = new Set((marketDataPlan?.timeframes || []).map(item => String(item?.timeframe || '').toUpperCase()))
    if (!timeframe) throw new Error('ema34_timeframe_required')
    if (!planned.has(timeframe)) throw new Error('ema34_timeframe_not_in_market_plan')
    if (policy?.mode === 'off' && !confirmEnableDataRuntime) throw new Error('strategy_data_runtime_confirmation_required')
    policy ||= minimalDataPolicy()
    if (policy.mode === 'off') policy.mode = 'shadow'
    policy.indicators = (policy.indicators || []).filter(item => item?.id !== SIMPLE_EMA34_INDICATOR_ID)
    policy.indicators.push(simpleEma34Declaration(timeframe))
    policy.ui ||= { groups:[] }
    policy.ui.simple_data_capabilities = {
      ...(policy.ui.simple_data_capabilities || {}),
      version:STRATEGY_DATA_CAPABILITIES_VERSION,
      managed_indicator_ids:[...new Set([...(policy.ui.simple_data_capabilities?.managed_indicator_ids || []), SIMPLE_EMA34_INDICATOR_ID])],
    }
  } else if (policy) {
    policy.indicators = (policy.indicators || []).filter(item => item?.id !== SIMPLE_EMA34_INDICATOR_ID)
    if (policy.ui?.simple_data_capabilities?.managed_indicator_ids) {
      policy.ui.simple_data_capabilities.managed_indicator_ids = policy.ui.simple_data_capabilities.managed_indicator_ids
        .filter(id => id !== SIMPLE_EMA34_INDICATOR_ID)
    }
    if (isEmptyManagedDataPolicy(policy)) policy = null
  }

  const compiled = policy ? compileStrategyPolicy(policy, { marketDataPlan }) : null
  const canonical = canonicalCompiledPolicyJson(compiled)
  return {
    strategyPolicyJson:canonical,
    useEma34Filter:Boolean(compiled?.indicators?.some(item => item.id === SIMPLE_EMA34_INDICATOR_ID)),
    capabilityState:describeSimpleIndicatorCapabilities(compiled, false),
  }
}

export function parseStrategyPolicy(strategy = {}) {
  const useEma34Filter = normalizeUseEma34Filter(strategy.use_ema34_filter)
  const marketDataPlan = normalizeMarketDataPlan(strategy.market_data_plan_json || strategy.market_data_plan, {
    prompt: strategy.system_prompt || '',
  })
  const useChanAnalysis = normalizeUseChanAnalysis(
    strategy.use_chan_analysis ?? strategy.market_data_plan?.use_chan_analysis,
    { prompt: strategy.system_prompt || '' },
  )
  validateChanTimeframes(marketDataPlan, useChanAnalysis)

  // A policy is an explicit declaration, rather than a hint that can be
  // silently discarded.  Compile it even when its mode is `off` so malformed
  // persisted JSON fails closed and its canonical hash remains available for
  // audit.  The data runtime below deliberately skips off-mode policies.
  // Treat an explicitly persisted `null` JSON column as a clear operation;
  // only fall back to the legacy alias when the JSON column is absent or
  // undefined.  This avoids resurrecting an old alias after a policy was
  // intentionally removed.
  const rawPolicyValue = strategy.strategy_policy_json !== undefined
    ? strategy.strategy_policy_json : strategy.strategy_policy
  const hasExplicitPolicy = rawPolicyValue !== undefined && rawPolicyValue !== null
    && !(typeof rawPolicyValue === 'string' && rawPolicyValue.trim() === '')
  let strategyPolicy = null
  if (hasExplicitPolicy) {
    if (typeof rawPolicyValue === 'string') {
      try { strategyPolicy = JSON.parse(rawPolicyValue) } catch {
        // Keep the public error stable; parser details must not turn a client
        // validation failure into an internal-error response.
        throw new StrategyPolicyValidationError('policy_json_invalid', '$')
      }
    } else {
      strategyPolicy = structuredClone(rawPolicyValue)
    }
  }
  const compiledPolicy = hasExplicitPolicy
    ? compileStrategyPolicy(rawPolicyValue, { marketDataPlan })
    : null
  return {
    entryMethods: normalizeEntryMethods(strategy.entry_methods_json || strategy.entry_methods || DEFAULT_ENTRY_METHODS),
    marketDataPlan,
    useChanAnalysis,
    useEma34Filter,
    strategyPolicy,
    // use_ema34_filter is retained only as a legacy audit/read field. It must
    // never create a runtime policy, add a market-data window, render prompt
    // instructions, or enable enforcement for new inference tasks.
    compiledPolicy,
    policyMode:compiledPolicy?.mode || 'off',
  }
}

function runtimeHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

/**
 * Build the always-present, historical strategy capability snapshot.  The
 * optional compiler runtime is merged into this object; it never determines
 * whether the base snapshot exists.
 */
export function buildStrategyRuntimeSnapshot({ strategy = {}, policy = {}, strategyPolicyRuntime = null, strategyDataRuntime = null, source = 'inference' } = {}) {
  const marketDataPlan = policy.marketDataPlan || {}
  const useChanAnalysis = Boolean(policy.useChanAnalysis)
  const chanTimeframes = useChanAnalysis
    ? [...new Set((marketDataPlan.timeframes || []).map(item => String(item?.timeframe || '').toUpperCase())
      .filter(timeframe => chanTimeframeSet.has(timeframe)))]
    : []
  const base = {
    strategy_runtime_version:1,
    data_capabilities_version:STRATEGY_DATA_CAPABILITIES_VERSION,
    strategy_id:Number(strategy.id || strategy.strategy_id || 0) || null,
    strategy_version:Number(strategy.version || strategy.strategy_version || 1),
    scope:strategy.scope || strategy.strategy_scope || null,
    source,
    market_data_plan:marketDataPlan,
    entry_methods:policy.entryMethods || [],
    use_chan_analysis:useChanAnalysis,
    chan_timeframes:chanTimeframes,
    window_policy_version:useChanAnalysis ? CHAN_WINDOW_POLICY_VERSION : CHAN_WINDOW_POLICY_VERSION,
    chan_window_policy_version:useChanAnalysis ? CHAN_WINDOW_POLICY_VERSION : CHAN_WINDOW_POLICY_VERSION,
    strategy_policy_mode:strategyDataRuntime?.mode || policy.policyMode || strategyPolicyRuntime?.mode || 'off',
    strategy_policy_hash:strategyDataRuntime?.policy_hash || strategyPolicyRuntime?.policy_hash || policy.compiledPolicy?.policy_hash || null,
  }
  // New snapshots carry the data-only runtime.  Keep the old runtime merge for
  // historical callers during the migration window, but never let it replace
  // an explicitly supplied data runtime.
  const runtime = { ...(strategyPolicyRuntime || {}), ...(strategyDataRuntime || {}), ...base }
  const hashInput = { ...runtime }
  delete hashInput.runtime_config_hash
  delete hashInput.strategy_runtime_hash
  runtime.runtime_config_hash = runtimeHash(hashInput)
  runtime.strategy_runtime_hash = runtime.runtime_config_hash
  return runtime
}

function summarizeIndicatorInputSource(timeframe, source = {}) {
  const bars = Array.isArray(source.bars) ? source.bars : Array.isArray(source.klines) ? source.klines : []
  const first = bars[0]
  const last = bars.at(-1)
  const timeOf = bar => {
    const numeric = Number(bar?.time_utc_msc ?? bar?.time_msc ?? bar?.time_server_msc)
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric
    const parsed = Date.parse(String(bar?.time || ''))
    return Number.isFinite(parsed) ? parsed : null
  }
  return {
    timeframe,
    market_source:source.marketSource || source.market_source || null,
    source_id:Number(source.sourceId ?? source.source_id) || null,
    source_type:source.sourceType || source.source_type || null,
    timezone_offset_minutes:Number.isFinite(Number(source.timezoneOffsetMinutes ?? source.timezone_offset_minutes))
      ? Number(source.timezoneOffsetMinutes ?? source.timezone_offset_minutes) : null,
    bar_count:bars.length,
    first_bar_time_utc_msc:timeOf(first),
    last_bar_time_utc_msc:timeOf(last),
    last_bar_closed:typeof source.lastBarClosed === 'boolean'
      ? source.lastBarClosed : typeof source.last_bar_closed === 'boolean' ? source.last_bar_closed : null,
    internal_gap_unresolved:source.internalGapUnresolved === true || source.internal_gap_unresolved === true,
  }
}

/**
 * Prepare only the neutral facts declared by a compiled policy.  This is the
 * fresh-inference data boundary: it never evaluates workflow/constraints,
 * renders prompt instructions, or mutates the caller's strategy context.
 */
export function prepareStrategyDataRuntime(policy, strategyContext, { rawPolicy = null } = {}) {
  const compiledPolicy = policy && Object.prototype.hasOwnProperty.call(policy, 'compiledPolicy')
    ? policy.compiledPolicy : policy
  if (!compiledPolicy || compiledPolicy.mode === 'off') return null

  const declaredSources = strategyContext?.policyIndicatorSources || {}
  // The private source map is the authoritative indicator input, while the
  // visible timeframe summary may carry additional broker/source identity
  // fields.  Join those metadata fields here without exposing extra bars or
  // changing the calculation inputs.
  const frameSources = Object.fromEntries(Object.entries(declaredSources).map(([timeframe, source]) => {
    const quality = strategyContext?.timeframes?.[timeframe]?.summary?.market_data_quality || {}
    const has = (key, alias) => source?.[key] !== undefined ? source[key] : source?.[alias] !== undefined ? source[alias] : quality[alias]
    return [timeframe, {
      ...quality,
      ...(source || {}),
      sourceId:has('sourceId', 'source_id'),
      sourceType:has('sourceType', 'source_type') || quality.platform || null,
      timezoneOffsetMinutes:has('timezoneOffsetMinutes', 'timezone_offset_minutes'),
      marketSource:has('marketSource', 'market_source') || quality.source_type || quality.platform || null,
      lastBarClosed:has('lastBarClosed', 'last_bar_closed'),
      internalGapUnresolved:source?.internalGapUnresolved !== undefined
        ? source.internalGapUnresolved : source?.internal_gap_unresolved !== undefined
          ? source.internal_gap_unresolved : Boolean(quality.cache_internal_gap_unresolved),
    }]
  }))
  const indicators = calculatePolicyIndicators(compiledPolicy, frameSources)
  const indicatorSourceTimeframes = [...new Set((compiledPolicy.indicators || [])
    .filter(definition => definition.enabled !== false)
    .map(definition => definition.source.timeframe))]
  const inputSources = Object.fromEntries(indicatorSourceTimeframes.map(timeframe => [
    timeframe, summarizeIndicatorInputSource(timeframe, frameSources[timeframe] || {}),
  ]))
  const auditIdentity = {
    data_runtime_version:'strategy-data-runtime-v1',
    policy_hash:compiledPolicy.policy_hash || null,
    schema_version:compiledPolicy.schema_version || null,
    engine_version:compiledPolicy.engine_version || null,
    indicator_algorithm_version:INDICATOR_ALGORITHM_VERSION,
    indicator_source_timeframes:indicatorSourceTimeframes,
    indicator_evidence_hashes:Object.fromEntries(Object.entries(indicators)
      .map(([id, evidence]) => [id, evidence?.evidence_hash || null])),
  }
  return {
    data_runtime_version:'strategy-data-runtime-v1',
    schema_version:compiledPolicy.schema_version,
    mode:compiledPolicy.mode,
    policy_hash:compiledPolicy.policy_hash,
    indicator_algorithm_version:INDICATOR_ALGORITHM_VERSION,
    indicator_source_timeframes:indicatorSourceTimeframes,
    indicator_evidence_hashes:auditIdentity.indicator_evidence_hashes,
    raw_policy:rawPolicy || policy?.strategyPolicy || null,
    compiled_policy:compiledPolicy,
    indicators,
    input_sources:inputSources,
    // Keep a descriptive alias for consumers that use the registry's
    // terminology; both fields are the same projected, non-bar source data.
    indicator_sources:inputSources,
    audit_identity:auditIdentity,
  }
}

export function prepareStrategyPolicyRuntime(policy, strategyContext, { rawPolicy = null } = {}) {
  // A parsed strategy with no compiled policy (including legacy
  // use_ema34_filter records) must stay completely outside the policy runtime.
  // Accept a compiled policy object directly for callers that already have
  // one, but do not fall back to the parsed wrapper when its field is null.
  const compiledPolicy = policy && Object.prototype.hasOwnProperty.call(policy, 'compiledPolicy')
    ? policy.compiledPolicy : policy
  if (!compiledPolicy || compiledPolicy.mode === 'off') return null
  const frameSources = strategyContext?.policyIndicatorSources || {}
  const indicators = calculatePolicyIndicators(compiledPolicy, frameSources)
  const workflowState = buildPreInferenceWorkflowState(compiledPolicy)
  const preInference = evaluateStrategyConstraints(compiledPolicy, {
    stages:{}, decision:{}, indicators, signal:{ side:'hold' }, evidence:{}, market:{},
  }, 'pre_inference')
  const prompt = renderStrategyPolicyPrompt(compiledPolicy, { indicators, workflow_state:workflowState })
  const runtime = {
    schema_version:compiledPolicy.schema_version,
    mode:compiledPolicy.mode,
    policy_hash:compiledPolicy.policy_hash,
    raw_policy:rawPolicy || policy?.strategyPolicy || null,
    compiled_policy:compiledPolicy,
    workflow_state:workflowState,
    indicators,
    constraint_results:{ pre_inference:preInference },
    prompt_renderer:prompt ? {
      renderer_version:prompt.renderer_version,
      rendered_hash:prompt.rendered_hash,
    } : null,
  }
  if (compiledPolicy.mode === 'enforce' && strategyContext) {
    strategyContext.compiled_policy = compiledPolicy
    strategyContext.workflow_state = workflowState
    strategyContext.indicators = indicators
  }
  return { ...runtime, rendered_prompt:prompt?.text || '' }
}

export function signalTypesForEntryMethods(methods) {
  const allowed = new Set(normalizeEntryMethods(methods))
  const types = ['hold']
  if (allowed.has('market')) types.unshift('buy', 'sell')
  if (allowed.has('limit')) types.unshift('buy_limit', 'sell_limit')
  if (allowed.has('stop')) types.unshift('buy_stop', 'sell_stop')
  if (allowed.has('stop_limit')) types.unshift('buy_stop_limit', 'sell_stop_limit')
  return types
}
