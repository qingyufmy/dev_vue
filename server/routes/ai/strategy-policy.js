import { hasLegacyUseChanTag, parseLegacyTimeframeTags } from './utils.js'
import { compileStrategyPolicy, STRATEGY_POLICY_TIMEFRAMES } from './strategy-policy-compiler.js'
import { calculatePolicyIndicators } from './indicator-registry.js'
import { buildPreInferenceWorkflowState } from './strategy-workflow-engine.js'
import { renderStrategyPolicyPrompt } from './strategy-prompt-renderer.js'
import { evaluateStrategyConstraints } from './strategy-constraint-engine.js'

export const VALID_TIMEFRAMES = STRATEGY_POLICY_TIMEFRAMES
export const VALID_ENTRY_METHODS = Object.freeze(['market', 'limit', 'stop', 'stop_limit'])
export const DEFAULT_ENTRY_METHODS = Object.freeze([...VALID_ENTRY_METHODS])

const timeframeSet = new Set(VALID_TIMEFRAMES)
const entryMethodSet = new Set(VALID_ENTRY_METHODS)

const HARDCODED_EMA34_POLICY = Object.freeze({
  schema_version:'strategy-policy-v1',
  mode:'enforce',
  features:[],
  indicators:[{
    id:'entry_ema34', kind:'ema', enabled:true,
    source:{ timeframe:'M5', field:'close', bar_scope:'closed_only' },
    params:{ period:34, minimum_bars:34, warmup_target_bars:170, evidence_window:5 },
  }],
  workflow:{ stages:[], selectors:[], default_decision:'allow' },
  constraints:[
    {
      id:'entry_indicator_ready', scope:'new_entry', phases:['post_inference', 'pre_submit'],
      require:{ left:{ ref:'indicators.entry_ema34.ready' }, op:'eq', right:true },
      on_fail:'hold_new_entry', counts_as_trigger:false,
    },
    {
      id:'buy_indicator_relation', scope:'new_entry', phases:['post_inference', 'pre_submit'],
      when:{ left:{ ref:'signal.side' }, op:'eq', right:'buy' },
      require:{ left:{ ref:'indicators.entry_ema34.bar.close' }, op:'gt', right:{ ref:'indicators.entry_ema34.value' } },
      on_fail:'hold_new_entry', counts_as_trigger:false,
    },
    {
      id:'sell_indicator_relation', scope:'new_entry', phases:['post_inference', 'pre_submit'],
      when:{ left:{ ref:'signal.side' }, op:'eq', right:'sell' },
      require:{ left:{ ref:'indicators.entry_ema34.bar.close' }, op:'lt', right:{ ref:'indicators.entry_ema34.value' } },
      on_fail:'hold_new_entry', counts_as_trigger:false,
    },
  ],
  prompt_rules:[{
    id:'entry_indicator_filter',
    text:'M5 已收盘 K 线 EMA34 是短线行情证据和新入场方向过滤器；可用于说明位置、斜率、距离、持续性与最近穿越，但不计作 M15 确认或 M5 触发，也不构成退出持仓或撤销挂单的理由。',
  }],
  ui:{ groups:[] },
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

function ensureEma34MarketData(marketDataPlan) {
  if (marketDataPlan.timeframes.some(item => item.timeframe === 'M5')) return marketDataPlan
  return {
    ...marketDataPlan,
    timeframes:[...marketDataPlan.timeframes, { timeframe:'M5', kline_count:100 }],
  }
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

export function parseStrategyPolicy(strategy = {}) {
  const useEma34Filter = normalizeUseEma34Filter(strategy.use_ema34_filter)
  let marketDataPlan = normalizeMarketDataPlan(strategy.market_data_plan_json || strategy.market_data_plan, {
    prompt: strategy.system_prompt || '',
  })
  if (useEma34Filter) marketDataPlan = ensureEma34MarketData(marketDataPlan)
  const compiledPolicy = useEma34Filter
    ? compileStrategyPolicy(HARDCODED_EMA34_POLICY, { marketDataPlan }) : null
  return {
    entryMethods: normalizeEntryMethods(strategy.entry_methods_json || strategy.entry_methods || DEFAULT_ENTRY_METHODS),
    marketDataPlan,
    useChanAnalysis: normalizeUseChanAnalysis(
      strategy.use_chan_analysis ?? strategy.market_data_plan?.use_chan_analysis,
      { prompt: strategy.system_prompt || '' },
    ),
    useEma34Filter,
    strategyPolicy:null,
    compiledPolicy,
    policyMode:useEma34Filter ? 'enforce' : 'off',
  }
}

export function prepareStrategyPolicyRuntime(policy, strategyContext, { rawPolicy = null } = {}) {
  const compiledPolicy = policy?.compiledPolicy || policy
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
