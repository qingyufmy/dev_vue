import { evaluatePolicyExpression } from './strategy-constraint-engine.js'

export const STRATEGY_WORKFLOW_ENGINE_VERSION = 'strategy-workflow-engine-v2'

function valueAt(root, path) {
  return String(path || '').split('.').reduce((value, key) => {
    if (value == null || typeof value !== 'object') return undefined
    return Object.hasOwn(value, key) ? value[key] : undefined
  }, root)
}

function traceStages(modelOutput) {
  const trace = modelOutput?.strategy_policy_trace || modelOutput?.workflow_trace || {}
  const stages = trace.stages || trace
  return stages && !Array.isArray(stages) && typeof stages === 'object' ? stages : {}
}

function normalizeStageOutput(stage, output = {}) {
  if (stage.kind === 'model_assessment') {
    return { state:String(output.state || 'unavailable').toLowerCase(), source:{ ...stage.source } }
  }
  const evidenceCount = Math.max(0, Number(output.evidence_count || 0))
  const minimum = Math.max(0, Number(stage.minimum_evidence_count || 0))
  return {
    passed:output.passed === true && evidenceCount >= minimum,
    evidence_count:evidenceCount,
    evidence_refs:Array.isArray(output.evidence_refs) ? output.evidence_refs.map(String) : [],
    source:{ ...stage.source },
  }
}

function selectDecision(compiledPolicy, context) {
  let finalDirection = null
  let effectiveTimeframe = null
  for (const selector of compiledPolicy?.workflow?.selectors || []) {
    if (!evaluatePolicyExpression(selector.when, context)) continue
    finalDirection = valueAt(context, selector.select_direction_from)
    effectiveTimeframe = valueAt(context, selector.select_timeframe_from)
    break
  }
  context.decision.final_direction = finalDirection
  context.decision.effective_timeframe = effectiveTimeframe
  return { finalDirection, effectiveTimeframe }
}

export function validateWorkflowTrace(compiledPolicy, modelOutput = {}, baseContext = {}) {
  const provided = traceStages(modelOutput)
  const stages = {}
  const errors = []
  const context = { ...baseContext, stages, decision:{} }

  for (const stage of compiledPolicy?.workflow?.stages || []) {
    // Selectors are intentionally refreshed after every stage. This lets a
    // later generic stage depend on decision.final_direction without teaching
    // the engine which timeframe or assessment role produced that decision.
    selectDecision(compiledPolicy, context)
    const active = stage.run_if ? evaluatePolicyExpression(stage.run_if, context) : true
    const rawOutput = provided[stage.id]
    if (!active) {
      if (rawOutput && rawOutput.state !== 'skipped' && rawOutput.skipped !== true) {
        errors.push({ code:'inactive_stage_supplied', stage_id:stage.id })
      }
      stages[stage.id] = { state:'skipped', skipped:true, reason:stage.on_skipped || 'condition_false', source:{ ...stage.source } }
      selectDecision(compiledPolicy, context)
      continue
    }
    if (!rawOutput || typeof rawOutput !== 'object') {
      errors.push({ code:'required_stage_missing', stage_id:stage.id })
      stages[stage.id] = stage.kind === 'model_assessment'
        ? { state:'unavailable', source:{ ...stage.source } }
        : { passed:false, evidence_count:0, evidence_refs:[], source:{ ...stage.source } }
      selectDecision(compiledPolicy, context)
      continue
    }
    const normalized = normalizeStageOutput(stage, rawOutput)
    if (stage.kind === 'model_assessment' && !stage.output_states.includes(normalized.state)) {
      errors.push({ code:'stage_output_state_invalid', stage_id:stage.id })
      normalized.state = 'unavailable'
    }
    if (stage.kind !== 'model_assessment'
      && normalized.evidence_count < Number(stage.minimum_evidence_count || 0)) {
      errors.push({ code:'stage_evidence_count_insufficient', stage_id:stage.id })
    }
    stages[stage.id] = normalized
    selectDecision(compiledPolicy, context)
  }

  const { finalDirection, effectiveTimeframe } = selectDecision(compiledPolicy, context)
  const defaulted = !finalDirection

  return {
    engine_version:STRATEGY_WORKFLOW_ENGINE_VERSION,
    compliant:errors.length === 0,
    errors,
    stages,
    decision:{
      final_direction:finalDirection,
      effective_timeframe:effectiveTimeframe,
      defaulted,
      default_action:defaulted ? compiledPolicy?.workflow?.default_decision || 'hold_new_entry' : 'allow',
    },
  }
}

export function workflowGateEvaluation(workflow) {
  const compliant = workflow?.compliant === true
  const defaulted = workflow?.decision?.defaulted === true
  const defaultAction = String(workflow?.decision?.default_action || 'hold_new_entry')
  const action = !compliant ? 'hold_new_entry' : defaulted ? defaultAction : 'allow'
  return {
    phase:'post_inference',
    scope:'new_entry',
    passed:action === 'allow' || action === 'skip_stage',
    action,
    workflow,
  }
}

export function buildPreInferenceWorkflowState(compiledPolicy) {
  return {
    engine_version:STRATEGY_WORKFLOW_ENGINE_VERSION,
    stages:Object.fromEntries((compiledPolicy?.workflow?.stages || []).map(stage => [stage.id, {
      status:stage.run_if ? 'conditional' : 'required',
      kind:stage.kind,
      source:{ ...stage.source },
      ...(stage.run_if ? { run_if:stage.run_if } : {}),
      ...(stage.minimum_evidence_count != null ? { minimum_evidence_count:stage.minimum_evidence_count } : {}),
    }])),
    decision:{ final_direction:null, effective_timeframe:null, default_action:compiledPolicy?.workflow?.default_decision || 'hold_new_entry' },
  }
}
