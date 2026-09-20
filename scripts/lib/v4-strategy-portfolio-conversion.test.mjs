import test from 'node:test'
import assert from 'node:assert/strict'
import { reviewStrategyPortfolio } from './v4-strategy-portfolio-conversion.mjs'

test('platform reference semantics do not turn off with the private portfolio flag', () => {
  for (const include_portfolio_context of ['0', '1']) {
    const result = reviewStrategyPortfolio({ scope: 'platform', include_portfolio_context })
    assert.equal(result.mode, 'strategy_reference')
    assert.equal(result.sourceCondition, 'strategy_observer_source_matches_market_source')
    assert.equal(result.sourceFailure, 'unavailable_not_empty')
    assert.equal(result.targetRole, 'trader')
    assert.equal(result.status, 'mapped')
    assert.deepEqual(result.targetConfig,{strategy_reference_portfolio:{version:1,mode:'required'}})
    assert.deepEqual(result.problems,[])
  }
})
test('private source context has distinct disabled and required owner-account semantics', () => {
  assert.equal(reviewStrategyPortfolio({ scope: 'private', include_portfolio_context: '0' }).mode, 'off')
  const enabled = reviewStrategyPortfolio({ scope: 'private', include_portfolio_context: '1' })
  assert.equal(enabled.mode, 'private_account')
  assert.equal(enabled.targetRole, 'trader')
  assert.equal(enabled.sourceFailure, 'block_on_unavailable')
})
test('unknown source flags are not silently interpreted as disabled', () => {
  assert.equal(reviewStrategyPortfolio({ scope: 'platform', include_portfolio_context: 'false' }).status, 'invalid')
  assert.equal(reviewStrategyPortfolio({ scope: 'user', include_portfolio_context: '0' }).status, 'invalid')
})
