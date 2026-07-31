import { queryOne } from '../../db.js'
import { platformRates } from './market-data.js'
import { calculatePolicyIndicators, indicatorRequiredHistory } from './indicator-registry.js'
import { evaluateStrategyConstraints } from './strategy-constraint-engine.js'
import { parseSnapshotJson } from './inference-snapshots.js'

export const STRATEGY_POLICY_SUBMIT_ENGINE_VERSION = 'strategy-policy-submit-v1'

function signalSide(request = {}) {
  const value = String(request.order_type || request.signal_type || '').toLowerCase()
  if (value.startsWith('buy')) return 'buy'
  if (value.startsWith('sell')) return 'sell'
  return 'hold'
}

export function evaluateFrozenStrategyPolicyForSubmission(strategyRuntime, sources, request = {}) {
  const mode = String(strategyRuntime?.mode || 'legacy_implicit')
  const compiledPolicy = strategyRuntime?.compiled_policy
  if (!compiledPolicy || mode === 'off' || mode === 'legacy_implicit') {
    return {
      engine_version:STRATEGY_POLICY_SUBMIT_ENGINE_VERSION,
      mode,
      policy_hash:strategyRuntime?.policy_hash || null,
      allowed:true,
      action:'allow',
      reason:'strategy_policy_not_enforced',
      indicators:{},
      evaluation:null,
    }
  }

  const indicators = calculatePolicyIndicators(compiledPolicy, sources || {})
  const workflow = strategyRuntime.workflow_state || {}
  const evaluation = evaluateStrategyConstraints(compiledPolicy, {
    stages:workflow.stages || {},
    decision:workflow.decision || {},
    indicators,
    signal:{ ...request, side:signalSide(request) },
    evidence:{
      inference_policy_hash:strategyRuntime.policy_hash || null,
      current_indicator_hashes:Object.fromEntries(Object.entries(indicators)
        .map(([id, evidence]) => [id, evidence?.evidence_hash || null])),
    },
    market:{ symbol:request.symbol || null },
  }, 'pre_submit')
  const wouldAllow = ['allow', 'skip_stage'].includes(evaluation.action)
  return {
    engine_version:STRATEGY_POLICY_SUBMIT_ENGINE_VERSION,
    mode,
    policy_hash:strategyRuntime.policy_hash || compiledPolicy.policy_hash || null,
    allowed:mode === 'shadow' ? true : wouldAllow,
    would_allow:wouldAllow,
    action:evaluation.action,
    reason:wouldAllow ? 'strategy_policy_pre_submit_passed' : 'strategy_policy_pre_submit_blocked',
    indicators,
    evaluation,
  }
}

async function loadFreshIndicatorSources(userId, request, compiledPolicy, ratesProvider) {
  const requiredByFrame = new Map()
  for (const definition of compiledPolicy?.indicators || []) {
    if (!definition.enabled) continue
    const timeframe = definition.source.timeframe
    requiredByFrame.set(timeframe, Math.max(
      requiredByFrame.get(timeframe) || 0,
      indicatorRequiredHistory(definition),
    ))
  }

  const entries = await Promise.all([...requiredByFrame.entries()].map(async ([timeframe, count]) => {
    const response = await ratesProvider(userId, {
      symbol:request.symbol,
      timeframe,
      count:Math.min(10_000, Math.max(10, count + 2)),
    })
    if (!response || response.status === 'error' || !Array.isArray(response.rates)) {
      return [timeframe, {
        bars:[], lastBarClosed:null, internalGapUnresolved:true,
        marketSource:response?.market_meta?.source || null,
      }]
    }
    return [timeframe, {
      bars:response.rates,
      lastBarClosed:typeof response.market_meta?.last_bar_closed === 'boolean'
        ? response.market_meta.last_bar_closed : null,
      internalGapUnresolved:response.market_meta?.internal_gap_unresolved === true,
      marketSource:response.market_meta?.source || 'platform_market_bridge',
    }]
  }))
  return Object.fromEntries(entries)
}

export async function evaluateSignalStrategyPolicyBeforeSubmission({
  userId,
  signalId,
  request,
  snapshotLoader = queryOne,
  ratesProvider = platformRates,
} = {}) {
  const id = Number(signalId)
  if (!Number.isInteger(id) || id <= 0) {
    return evaluateFrozenStrategyPolicyForSubmission(null, {}, request)
  }
  const snapshot = await snapshotLoader(`SELECT strategy_runtime_json
    FROM inference_snapshots WHERE signal_id = ? ORDER BY id DESC LIMIT 1`, [id])
  const runtime = parseSnapshotJson(snapshot?.strategy_runtime_json, null)
  if (!runtime?.compiled_policy || ['off', 'legacy_implicit'].includes(String(runtime.mode || 'legacy_implicit'))) {
    return evaluateFrozenStrategyPolicyForSubmission(runtime, {}, request)
  }
  const sources = await loadFreshIndicatorSources(userId, request || {}, runtime.compiled_policy, ratesProvider)
  return evaluateFrozenStrategyPolicyForSubmission(runtime, sources, request)
}
