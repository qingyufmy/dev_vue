import { positivePercent } from '../../../shared/positive-percent.js'
import type { RiskAction } from './risk-action.js'
import { PositionSizingError } from './position-tier-sizing.js'

export function actionRiskCeiling(action: RiskAction): string | undefined {
  if (!Object.hasOwn(action.parameters, 'risk_ceiling_percent')) return undefined
  if (action.kind !== 'market_order' && action.kind !== 'pending_order') throw new PositionSizingError('action_risk_ceiling_kind_invalid')
  try { return positivePercent(action.parameters.risk_ceiling_percent) }
  catch { throw new PositionSizingError('action_risk_ceiling_invalid') }
}
