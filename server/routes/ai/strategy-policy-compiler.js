import crypto from 'node:crypto'

export const STRATEGY_POLICY_SCHEMA_VERSION = 'strategy-policy-v1'
export const STRATEGY_POLICY_ENGINE_VERSION = 'strategy-policy-engine-v2'
export const STRATEGY_POLICY_TIMEFRAMES = Object.freeze(['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'])

const MODES = new Set(['off', 'shadow', 'enforce'])
const FEATURE_KINDS = new Set(['chan_structure'])
const INDICATOR_KINDS = new Set(['ema', 'sma'])
const STAGE_KINDS = new Set(['model_assessment', 'model_confirmation', 'model_trigger'])
const OPERATORS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'all', 'any', 'not'])
const ACTIONS = new Set(['allow', 'hold_new_entry', 'reject_submission', 'skip_stage'])
const PHASES = new Set(['pre_inference', 'post_inference', 'pre_submit'])
const SCOPES = new Set(['new_entry'])
const BAR_SCOPES = new Set(['closed_only', 'live'])
const PRICE_FIELDS = new Set(['open', 'high', 'low', 'close'])
const REFERENCE_ROOTS = new Set(['stages', 'indicators', 'decision', 'signal', 'evidence', 'market'])
const STAGE_REF_FIELDS = new Set(['state', 'skipped', 'passed', 'evidence_count', 'source.timeframe'])
const INDICATOR_REF_FIELDS = new Set([
  'ready', 'value', 'reason', 'bars_used', 'bar.time', 'bar.time_utc_msc',
  'bar.open', 'bar.high', 'bar.low', 'bar.close', 'source.timeframe', 'source.field',
  'source.bar_scope', 'source.market_source', 'evidence_hash', 'algorithm_version',
])
const DECISION_REF_FIELDS = new Set(['final_direction', 'effective_timeframe', 'defaulted', 'default_action'])
const SIGNAL_REF_FIELDS = new Set([
  'side', 'signal_type', 'order_type', 'entry_method', 'limit_price', 'stop_limit_price',
  'stop_loss_price', 'take_profit_1_price', 'take_profit_2_price', 'take_profit_3_price',
])
const EVIDENCE_REF_FIELDS = new Set(['inference_policy_hash'])
const MARKET_REF_FIELDS = new Set(['symbol', 'latest_price', 'timeframe'])
const ID_RE = /^[a-z][a-z0-9_]{0,63}$/

export class StrategyPolicyValidationError extends Error {
  constructor(code, path, message = code) {
    super(message)
    this.name = 'StrategyPolicyValidationError'
    this.code = code
    this.path = path
  }
}

function fail(code, path, message) {
  throw new StrategyPolicyValidationError(code, path, message)
}

function parsePolicy(value) {
  if (value == null || value === '') return null
  if (typeof value === 'object' && !Array.isArray(value)) return structuredClone(value)
  try {
    const parsed = JSON.parse(String(value))
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') fail('policy_object_required', '$')
    return parsed
  } catch (error) {
    if (error instanceof StrategyPolicyValidationError) throw error
    fail('policy_json_invalid', '$', error.message)
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]))
}

export function canonicalPolicyJson(value) {
  return JSON.stringify(canonicalize(value))
}

function hashCanonical(value) {
  return crypto.createHash('sha256').update(canonicalPolicyJson(value), 'utf8').digest('hex')
}

function assertId(value, path) {
  const id = String(value || '')
  if (!ID_RE.test(id)) fail('policy_id_invalid', path)
  return id
}

function assertUnique(items, path) {
  const ids = new Set()
  for (let index = 0; index < items.length; index += 1) {
    const id = assertId(items[index]?.id, `${path}[${index}].id`)
    if (ids.has(id)) fail('policy_id_duplicate', `${path}[${index}].id`)
    ids.add(id)
  }
  return ids
}

function assertTimeframe(value, path, available) {
  const timeframe = String(value || '').toUpperCase()
  if (!STRATEGY_POLICY_TIMEFRAMES.includes(timeframe)) fail('policy_timeframe_invalid', path)
  if (available && !available.has(timeframe)) fail('policy_timeframe_not_in_market_plan', path)
  return timeframe
}

function assertRef(ref, path, ids) {
  const value = String(ref || '')
  const parts = value.split('.')
  if (parts.length < 2 || !REFERENCE_ROOTS.has(parts[0])) fail('policy_reference_invalid', path)
  if (parts[0] === 'stages' && !ids.stageIds.has(parts[1])) fail('policy_stage_reference_missing', path)
  if (parts[0] === 'indicators' && !ids.indicatorIds.has(parts[1])) fail('policy_indicator_reference_missing', path)
  const root = parts[0]
  const field = parts.slice(root === 'stages' || root === 'indicators' ? 2 : 1).join('.')
  const allowed = root === 'stages' ? STAGE_REF_FIELDS
    : root === 'indicators' ? INDICATOR_REF_FIELDS
      : root === 'decision' ? DECISION_REF_FIELDS
        : root === 'signal' ? SIGNAL_REF_FIELDS
          : root === 'evidence' ? EVIDENCE_REF_FIELDS
            : MARKET_REF_FIELDS
  if (!allowed.has(field)) fail('policy_reference_field_forbidden', path)
  return value
}

function normalizeOperand(value, path, ids) {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'ref')) {
    return { ref:assertRef(value.ref, `${path}.ref`, ids) }
  }
  if (Array.isArray(value)) return value.map((item, index) => normalizeOperand(item, `${path}[${index}]`, ids))
  if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value
  fail('policy_operand_invalid', path)
}

function normalizeExpression(expression, path, ids) {
  if (!expression || Array.isArray(expression) || typeof expression !== 'object') fail('policy_expression_invalid', path)
  if (Object.hasOwn(expression, 'all') || Object.hasOwn(expression, 'any')) {
    const operator = Object.hasOwn(expression, 'all') ? 'all' : 'any'
    const children = expression[operator]
    if (!OPERATORS.has(operator) || !Array.isArray(children) || children.length === 0) fail('policy_expression_children_required', `${path}.${operator}`)
    return { [operator]:children.map((child, index) => normalizeExpression(child, `${path}.${operator}[${index}]`, ids)) }
  }
  if (Object.hasOwn(expression, 'not')) {
    return { not:normalizeExpression(expression.not, `${path}.not`, ids) }
  }
  const op = String(expression.op || '')
  if (!OPERATORS.has(op) || ['all', 'any', 'not'].includes(op)) fail('policy_operator_invalid', `${path}.op`)
  return {
    left:normalizeOperand(expression.left, `${path}.left`, ids),
    op,
    right:normalizeOperand(expression.right, `${path}.right`, ids),
  }
}

function expressionStageDependencies(expression, target = new Set()) {
  if (!expression || typeof expression !== 'object') return target
  if (typeof expression.ref === 'string' && expression.ref.startsWith('stages.')) target.add(expression.ref.split('.')[1])
  for (const value of Object.values(expression)) expressionStageDependencies(value, target)
  return target
}

function expressionUsesDecision(expression) {
  if (!expression || typeof expression !== 'object') return false
  if (typeof expression.ref === 'string' && expression.ref.startsWith('decision.')) return true
  return Object.values(expression).some(expressionUsesDecision)
}

function assertWorkflowAcyclic(stages, selectors) {
  const decisionDependencies = new Set()
  for (const selector of selectors) {
    expressionStageDependencies(selector.when, decisionDependencies)
    expressionStageDependencies({ ref:selector.select_direction_from }, decisionDependencies)
    expressionStageDependencies({ ref:selector.select_timeframe_from }, decisionDependencies)
  }
  const graph = new Map(stages.map(stage => {
    const dependencies = expressionStageDependencies(stage.run_if)
    if (expressionUsesDecision(stage.run_if)) {
      for (const dependency of decisionDependencies) dependencies.add(dependency)
    }
    return [stage.id, dependencies]
  }))
  const order = new Map(stages.map((stage, index) => [stage.id, index]))
  const visiting = new Set()
  const visited = new Set()
  const visit = id => {
    if (visiting.has(id)) fail('policy_workflow_cycle', `$.workflow.stages.${id}`)
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of graph.get(id) || []) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of graph.keys()) visit(id)
  for (const [id, dependencies] of graph) {
    for (const dependency of dependencies) {
      if (Number(order.get(dependency)) >= Number(order.get(id))) {
        fail('policy_workflow_forward_reference', `$.workflow.stages.${id}`)
      }
    }
  }
}

function integerParam(value, path, { min = 1, max = 10000, fallback = null } = {}) {
  const numeric = value == null && fallback != null ? fallback : Number(value)
  if (!Number.isInteger(numeric) || numeric < min || numeric > max) fail('policy_integer_param_invalid', path)
  return numeric
}

export function compileStrategyPolicy(value, { marketDataPlan = null } = {}) {
  const raw = parsePolicy(value)
  if (!raw) return null
  if (raw.schema_version !== STRATEGY_POLICY_SCHEMA_VERSION) fail('policy_schema_unsupported', '$.schema_version')
  const mode = String(raw.mode || 'off').toLowerCase()
  if (!MODES.has(mode)) fail('policy_mode_invalid', '$.mode')

  const plannedTimeframes = Array.isArray(marketDataPlan?.timeframes)
    ? new Set(marketDataPlan.timeframes.map(item => String(item?.timeframe || '').toUpperCase()).filter(Boolean))
    : null
  const features = Array.isArray(raw.features) ? raw.features : []
  const indicators = Array.isArray(raw.indicators) ? raw.indicators : []
  const workflow = raw.workflow && typeof raw.workflow === 'object' ? raw.workflow : { stages:[], selectors:[], default_decision:'hold_new_entry' }
  const stages = Array.isArray(workflow.stages) ? workflow.stages : []
  const selectors = Array.isArray(workflow.selectors) ? workflow.selectors : []
  const constraints = Array.isArray(raw.constraints) ? raw.constraints : []
  const promptRules = Array.isArray(raw.prompt_rules) ? raw.prompt_rules : []
  const ui = raw.ui && typeof raw.ui === 'object' && !Array.isArray(raw.ui) ? structuredClone(raw.ui) : { groups:[] }

  assertUnique(features, '$.features')
  const indicatorIds = assertUnique(indicators, '$.indicators')
  const stageIds = assertUnique(stages, '$.workflow.stages')
  assertUnique(constraints, '$.constraints')
  assertUnique(promptRules, '$.prompt_rules')
  const ids = { indicatorIds, stageIds }

  const normalizedFeatures = features.map((feature, index) => {
    const kind = String(feature.kind || '')
    if (!FEATURE_KINDS.has(kind)) fail('policy_feature_kind_unsupported', `$.features[${index}].kind`)
    return { id:feature.id, kind, enabled:feature.enabled !== false }
  })

  const normalizedIndicators = indicators.map((definition, index) => {
    const base = `$.indicators[${index}]`
    const kind = String(definition.kind || '').toLowerCase()
    if (!INDICATOR_KINDS.has(kind)) fail('policy_indicator_kind_unsupported', `${base}.kind`)
    const source = definition.source || {}
    const field = String(source.field || 'close').toLowerCase()
    const barScope = String(source.bar_scope || 'closed_only').toLowerCase()
    if (!PRICE_FIELDS.has(field)) fail('policy_indicator_field_invalid', `${base}.source.field`)
    if (!BAR_SCOPES.has(barScope)) fail('policy_indicator_bar_scope_invalid', `${base}.source.bar_scope`)
    const period = integerParam(definition.params?.period, `${base}.params.period`, { max:1999 })
    const minimumBars = integerParam(definition.params?.minimum_bars, `${base}.params.minimum_bars`, { min:period, max:1999, fallback:period })
    const warmupTargetBars = integerParam(definition.params?.warmup_target_bars, `${base}.params.warmup_target_bars`, { min:minimumBars, max:1999, fallback:minimumBars })
    const evidenceWindow = integerParam(definition.params?.evidence_window, `${base}.params.evidence_window`, { min:2, max:50, fallback:5 })
    return {
      id:definition.id,
      kind,
      enabled:definition.enabled !== false,
      source:{ timeframe:assertTimeframe(source.timeframe, `${base}.source.timeframe`, plannedTimeframes), field, bar_scope:barScope },
      params:{ period, minimum_bars:minimumBars, warmup_target_bars:warmupTargetBars, evidence_window:evidenceWindow },
    }
  })

  const normalizedStages = stages.map((stage, index) => {
    const base = `$.workflow.stages[${index}]`
    const kind = String(stage.kind || '')
    if (!STAGE_KINDS.has(kind)) fail('policy_stage_kind_unsupported', `${base}.kind`)
    const source = { timeframe:assertTimeframe(stage.source?.timeframe, `${base}.source.timeframe`, plannedTimeframes) }
    const outputStates = Array.isArray(stage.output_states)
      ? [...new Set(stage.output_states.map(item => String(item || '').trim()).filter(Boolean))] : []
    if (kind === 'model_assessment' && outputStates.length === 0) fail('policy_stage_output_states_required', `${base}.output_states`)
    return {
      id:stage.id,
      kind,
      source,
      ...(outputStates.length ? { output_states:outputStates } : {}),
      ...(stage.run_if ? { run_if:normalizeExpression(stage.run_if, `${base}.run_if`, ids) } : {}),
      ...(stage.on_skipped ? { on_skipped:String(stage.on_skipped) } : {}),
      ...(stage.minimum_evidence_count != null
        ? { minimum_evidence_count:integerParam(stage.minimum_evidence_count, `${base}.minimum_evidence_count`, { min:0, max:100 }) }
        : {}),
    }
  })
  const normalizedSelectors = selectors.map((selector, index) => {
    const base = `$.workflow.selectors[${index}]`
    return {
      when:normalizeExpression(selector.when, `${base}.when`, ids),
      select_direction_from:assertRef(selector.select_direction_from, `${base}.select_direction_from`, ids),
      select_timeframe_from:assertRef(selector.select_timeframe_from, `${base}.select_timeframe_from`, ids),
    }
  })
  assertWorkflowAcyclic(normalizedStages, normalizedSelectors)
  const defaultDecision = String(workflow.default_decision || 'hold_new_entry')
  if (!ACTIONS.has(defaultDecision)) fail('policy_default_decision_invalid', '$.workflow.default_decision')

  const normalizedConstraints = constraints.map((constraint, index) => {
    const base = `$.constraints[${index}]`
    const scope = String(constraint.scope || 'new_entry')
    if (!SCOPES.has(scope)) fail('policy_constraint_scope_invalid', `${base}.scope`)
    const phases = [...new Set((Array.isArray(constraint.phases) ? constraint.phases : []).map(String))]
    if (!phases.length || phases.some(phase => !PHASES.has(phase))) fail('policy_constraint_phase_invalid', `${base}.phases`)
    const onFail = String(constraint.on_fail || '')
    if (!ACTIONS.has(onFail)) fail('policy_constraint_action_invalid', `${base}.on_fail`)
    return {
      id:constraint.id,
      scope,
      phases,
      ...(constraint.when ? { when:normalizeExpression(constraint.when, `${base}.when`, ids) } : {}),
      require:normalizeExpression(constraint.require, `${base}.require`, ids),
      on_fail:onFail,
      counts_as_trigger:constraint.counts_as_trigger === true,
    }
  })

  const normalizedPromptRules = promptRules.map((rule, index) => {
    const text = String(rule.text || '').trim()
    if (!text || text.length > 4000) fail('policy_prompt_rule_invalid', `$.prompt_rules[${index}].text`)
    return { id:rule.id, text }
  })

  const compiled = canonicalize({
    schema_version:STRATEGY_POLICY_SCHEMA_VERSION,
    engine_version:STRATEGY_POLICY_ENGINE_VERSION,
    mode,
    features:normalizedFeatures,
    indicators:normalizedIndicators,
    workflow:{ stages:normalizedStages, selectors:normalizedSelectors, default_decision:defaultDecision },
    constraints:normalizedConstraints,
    prompt_rules:normalizedPromptRules,
    ui,
  })
  return { ...compiled, policy_hash:hashCanonical(compiled) }
}

export function strategyPolicyMode(value) {
  const raw = parsePolicy(value)
  if (!raw) return 'off'
  const mode = String(raw.mode || 'off').toLowerCase()
  return MODES.has(mode) ? mode : 'invalid'
}
