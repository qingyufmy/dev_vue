import { hash } from './v4-backfill-contract.mjs'

// Legacy scheduler treats platform reference portfolios independently from the
// private include_portfolio_context flag. Mapping does not admit prompts or enable execution.
export function reviewStrategyPortfolio(row) {
  const source = { scope: row.scope, include_portfolio_context: row.include_portfolio_context }
  if (!['platform', 'private'].includes(source.scope) || !['0', '1'].includes(source.include_portfolio_context)) {
    return { sourceHash: hash(source), status: 'invalid', mode: null, problems: [{ field: 'include_portfolio_context', code: 'portfolio_source_invalid' }] }
  }
  if (source.scope === 'platform') return {
    sourceHash: hash(source), status: 'mapped', mode: 'strategy_reference',
    sourceCondition: 'strategy_observer_source_matches_market_source',
    sourceContents: 'open_or_closing_strategy_outcomes_joined_to_live_source_inventory',
    sourceFailure: 'unavailable_not_empty', targetRole: 'trader',
    targetConfig: { strategy_reference_portfolio: { version: 1, mode: 'required' } },
    runtimeEvidence: 'docs/architecture/history-completion-transaction-reference-v53-20260910.json',
    problems: [],
  }
  if (source.include_portfolio_context === '1') return {
    sourceHash: hash(source), status: 'mapping_required', mode: 'private_account',
    sourceCondition: 'private_owner_portfolio_enabled', sourceContents: 'private_owner_positions_and_pending_orders',
    sourceFailure: 'block_on_unavailable', targetRole: 'trader',
    problems: [{ field: 'include_portfolio_context', code: 'portfolio_context_runtime_mapping_required' }],
  }
  return { sourceHash: hash(source), status: 'not_requested', mode: 'off', targetRole: null, problems: [] }
}
