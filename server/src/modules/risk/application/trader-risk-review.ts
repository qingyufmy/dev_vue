import { samePositionState } from '../../trading/index.js'
import { evaluateRisk, RiskError, type RiskEvaluationInput } from '../domain/risk.js'

/** Keep the AI proposal frozen; only approved actions bind the freshly reviewed dynamic state. */
export function evaluateTraderRisk(input: RiskEvaluationInput, now: Date) {
  const quoteRevision = input.currentRevisions.quote
  if (!Number.isSafeInteger(quoteRevision) || quoteRevision < 1 || input.quote.revision !== quoteRevision) {
    throw new RiskError('risk_review_quote_revision_conflict', 422)
  }
  const accountRevision = input.currentRevisions.account
  const riskRevision = input.currentRevisions.risk
  for (const key of ['account', 'risk', 'quote'] as const) {
    const current = input.currentRevisions[key]
    if (!Number.isSafeInteger(current) || current < 1) throw new RiskError(`risk_review_${key}_revision_conflict`, 422)
    for (const action of input.result.actions) {
      const captured = action.expectedState[`${key}Revision`]
      if (typeof captured !== 'number' || !Number.isSafeInteger(captured) || captured < 1 || captured > current) {
        throw new RiskError(`risk_review_${key}_revision_conflict`, 422)
      }
    }
  }
  const positionsRevision = input.currentRevisions.positions
  const frozen = input.frozenPositions
  const positionsReviewed = !!frozen && Number.isSafeInteger(frozen.revision) && frozen.revision > 0
    && Number.isSafeInteger(positionsRevision) && positionsRevision >= frozen.revision
    && input.result.actions.every(action => action.expectedState.positionsRevision === frozen.revision)
    && input.positions.every(position => position.revision === positionsRevision)
    && samePositionState(frozen.positions, input.positions, input.policy.accountId)
  const evaluation = evaluateRisk({ ...input,
    requiredRevisionKeys: positionsReviewed ? ['analysis', 'subscription', 'pendingOrders', 'contract'] : ['analysis', 'subscription', 'positions', 'pendingOrders', 'contract'],
  }, now)
  if (evaluation.status !== 'approved') return evaluation
  return { ...evaluation,
    rules: [...evaluation.rules, ...(positionsReviewed ? [{ code: 'RISK_POSITION_STATE_REVIEWED', outcome: 'passed' as const,
      actionId: null, details: { captured_revision: frozen!.revision, positions_revision: positionsRevision } }] : []), { code: 'RISK_QUOTE_REVIEWED', outcome: 'passed' as const, actionId: null,
      details: { quote_revision: quoteRevision, observed_at: input.quote.observedAt,
        bid: input.quote.bid, ask: input.quote.ask } },
      { code: 'RISK_ACCOUNT_STATE_REVIEWED', outcome: 'passed' as const, actionId: null,
        details: { account_revision: accountRevision, risk_revision: riskRevision,
          observed_at: input.summary.observedAt, equity: input.summary.equity, free_margin: input.summary.freeMargin } }],
    approvedActions: evaluation.approvedActions.map(action => ({ ...action,
      expectedState: { ...action.expectedState, ...(positionsReviewed ? { positionsRevision } : {}), quoteRevision, accountRevision, riskRevision },
    })),
  }
}
