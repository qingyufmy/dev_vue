import type { RiskAction, RiskJsonObject } from './risk-action.js'
import type { EffectiveRiskPolicy } from './risk-state.js'
import type { StrategyBudgetContext } from './strategy-budget-context.js'
import { actionRiskCeiling } from './action-risk-ceiling.js'
import { calculatePositionTierVolume, PositionSizingError, resolvePositionSizeTier, type PositionSizeTier } from './position-tier-sizing.js'

export interface PositionSizingContext {
  decisionId: string
  decisionRevision: number
  accountId: string
  userId: number
  policyHash: string
  sourceEvidence?: { snapshotId: string; snapshotHash: string; decisionHash: string }
  revisions: PositionSizingRevisions
  actions: Array<{ actionId: string; evidenceCap: PositionSizeTier; applyAddCap: boolean }>
}

export interface PositionSizingRevisions {
  analysis: number; subscription: number; account: number; positions: number
  pendingOrders: number; quote: number; contract: number; risk: number
}

interface PositionSizingInput {
  strategyBudgetContext?: StrategyBudgetContext
  decisionId: string; decisionRevision: number; policy: EffectiveRiskPolicy
  result: { actions: RiskAction[] }; positionSizingContext?: PositionSizingContext; currentRevisions: PositionSizingRevisions
  summary: { equity: string }; quote: { bid: string; ask: string }
  instrument: { tickSize: string; tickValue: string; volumeMin: string; volumeMax: string; volumeStep: string }
}
interface SizingRule { code: string; outcome: 'passed'; actionId: string; details: RiskJsonObject }

export function resolvePositionTierActions(input: PositionSizingInput, policyHash: string) {
  const selected = input.result.actions.filter(action => Object.hasOwn(action.parameters, 'position_size_tier'))
  if (!selected.length) return { actions: input.result.actions, rules: [] as SizingRule[] }
  const fail = (code: string): never => { throw new PositionSizingError(code) }
  if (selected.some(action => !['market_order', 'pending_order'].includes(action.kind))) fail('position_size_action_invalid')
  if (selected.some(action => Object.hasOwn(action.parameters, 'volume') || Object.hasOwn(action.parameters, 'position_size_factor'))) fail('position_size_mode_conflict')
  const context = input.positionSizingContext
  if (!context) return fail('position_sizing_context_missing')
  if (context.decisionId !== input.decisionId || context.decisionRevision !== input.decisionRevision
    || context.accountId !== input.policy.accountId || context.userId !== input.policy.userId || context.policyHash !== policyHash
    || Object.keys(input.currentRevisions).some(key => context.revisions[key as keyof typeof context.revisions] !== input.currentRevisions[key as keyof typeof input.currentRevisions])) fail('position_sizing_context_stale')
  if (new Set(context.actions.map(action => action.actionId)).size !== context.actions.length) fail('position_sizing_context_duplicate')
  const rules: SizingRule[] = []
  const actions = input.result.actions.map(action => {
    if (!Object.hasOwn(action.parameters, 'position_size_tier')) return action
    const cap = context.actions.find(item => item.actionId === action.actionId)
    if (!cap) return fail('position_sizing_action_context_missing')
    const resolvedTier = resolvePositionSizeTier({ requested: action.parameters.position_size_tier, evidenceCap: cap.evidenceCap, applyAddCap: cap.applyAddCap })
    const side = String(action.parameters.side ?? (String(action.parameters.type ?? '').startsWith('buy') ? 'buy' : String(action.parameters.type ?? '').startsWith('sell') ? 'sell' : ''))
    if (side !== 'buy' && side !== 'sell') return fail('position_size_side_invalid')
    const entry = action.kind === 'market_order' ? (side === 'buy' ? input.quote.ask : input.quote.bid) : action.parameters.price
    const stopLoss = action.parameters.stop_loss ?? action.parameters.sl
    if (typeof entry !== 'string' || typeof stopLoss !== 'string') return fail('position_size_price_invalid')
    const actionCeiling = actionRiskCeiling(action)
    const sized = calculatePositionTierVolume({ resolvedTier, equity: input.summary.equity,
      ...(actionCeiling === undefined ? {} : { actionRiskCeilingPercent: actionCeiling }),
      ...(input.strategyBudgetContext?.strategyRiskCeilingPercent === undefined ? {} : { strategyRiskCeilingPercent: input.strategyBudgetContext.strategyRiskCeilingPercent }),
      maxRiskPerTradePercent: String(input.policy.values.maxRiskPerTradePercent), entry, stopLoss,
      tickSize: input.instrument.tickSize, tickValue: input.instrument.tickValue, volumeMin: input.instrument.volumeMin,
      volumeMax: input.instrument.volumeMax, volumeStep: input.instrument.volumeStep, maxOrderVolume: String(input.policy.values.maxOrderVolume) })
    rules.push({ code: 'RISK_POSITION_SIZE_RESOLVED', outcome: 'passed', actionId: action.actionId,
      details: { requested_tier: action.parameters.position_size_tier!, resolved_tier: resolvedTier, volume: sized.volume,
        calculation_source: sized.calculationSource, evidence_cap: cap.evidenceCap, add_cap_applied: cap.applyAddCap,
        action_risk_ceiling_percent: actionCeiling ?? null,
        ...(context.sourceEvidence ? { source_evidence: { ...context.sourceEvidence } } : {}) } })
    const { position_size_tier: _requestedTier, ...parameters } = action.parameters
    return { ...action, parameters: { ...parameters, volume: sized.volume } }
  })
  return { actions, rules }
}
