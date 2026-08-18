import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DEDUP_PRICE_ATR,
  DuplicateLivePendingError,
  findDuplicateLivePending,
  livePendingPriceTolerance,
  normalizeLivePendingType,
} from '../../server/routes/ai/live-pending-dedup.js'

const owner = {
  delivery_id:44,
  signal_id:901,
  prompt_type_id:7,
  pending_ticket:'7001',
  delivery_user_id:18,
  intent_user_id:18,
  intent_trading_account_id:33,
  order_intent_status:'succeeded',
  execution_status:'success',
  pending_state:'pending',
}

const request = {
  symbol:'XAUUSD', order_type:'buy', entry_method:'limit', limit_price:4405.68,
  atr_anchor:10,
}

describe('live pending duplicate guard', () => {
  it('matches the same strategy/account system pending order after symbol normalization', () => {
    const duplicate = findDuplicateLivePending({
      pendingOrders:[{ ticket:7001, symbol:'XAUUSD.s', pending_type:'BUY_LIMIT', magic:234000, price:4405.7 }],
      request,
      strategyDeliveries:[owner],
      userId:18,
      tradingAccountId:33,
      strategyId:7,
      instrument:{ tick_size:0.01, point:0.01 },
    })

    expect(duplicate).toMatchObject({
      ticket:'7001', symbol:'XAUUSD', direction:'buy', pending_type:'buy_limit',
      strategy_id:7, trading_account_id:33,
    })
    expect(duplicate.price_tolerance).toBeCloseTo(10 * DEFAULT_DEDUP_PRICE_ATR)
  })

  it('does not touch manual or other-strategy pending orders', () => {
    const pendingOrders = [
      { ticket:7002, symbol:'XAUUSD', pending_type:'BUY_LIMIT', magic:0, price:4405.68 },
      { ticket:7003, symbol:'XAUUSD', pending_type:'BUY_LIMIT', magic:234000, price:4405.68 },
    ]
    expect(findDuplicateLivePending({
      pendingOrders, request,
      strategyDeliveries:[{ ...owner, pending_ticket:'7003', prompt_type_id:99 }],
      userId:18, tradingAccountId:33, strategyId:7,
      instrument:{ tick_size:0.01, point:0.01 },
    })).toBeNull()
  })

  it('fails closed on ownership/account evidence instead of trusting a ticket alone', () => {
    expect(findDuplicateLivePending({
      pendingOrders:[{ ticket:7001, symbol:'XAUUSD', pending_type:'BUY_LIMIT', magic:234000, price:4405.68 }],
      request,
      strategyDeliveries:[{ ...owner, intent_trading_account_id:99 }],
      userId:18, tradingAccountId:33, strategyId:7,
      instrument:{ tick_size:0.01, point:0.01 },
    })).toBeNull()
  })

  it('still matches a live terminal order when database lifecycle state is stale', () => {
    const duplicate = findDuplicateLivePending({
      pendingOrders:[{ ticket:7001, symbol:'XAUUSD', pending_type:'BUY_LIMIT', magic:234000, price:4405.68 }],
      request,
      strategyDeliveries:[{
        ...owner,
        order_intent_status:'failed',
        execution_status:'expired',
        pending_state:'cancelled',
        outcome_status:'closed',
      }],
      userId:18, tradingAccountId:33, strategyId:7,
      instrument:{ tick_size:0.01, point:0.01 },
    })

    expect(duplicate).toMatchObject({ ticket:'7001', current:4405.68, limit:0.5 })
  })

  it('can use outcome ticket lineage when delivery ticket state is stale', () => {
    const duplicate = findDuplicateLivePending({
      pendingOrders:[{ ticket:7001, symbol:'XAUUSD', pending_type:'BUY_LIMIT', magic:234000, price:4405.68 }],
      request,
      strategyDeliveries:[{
        ...owner, pending_ticket:null, trade_ticket:null,
        outcome_pending_ticket:'7001', outcome_user_id:18,
        outcome_trading_account_id:33, outcome_strategy_id:7,
      }],
      userId:18, tradingAccountId:33, strategyId:7,
      instrument:{ tick_size:0.01, point:0.01 },
    })

    expect(duplicate).toMatchObject({ ticket:'7001' })
  })

  it('does not match database lineage when the terminal has no live pending order', () => {
    expect(findDuplicateLivePending({
      pendingOrders:[], request, strategyDeliveries:[owner],
      userId:18, tradingAccountId:33, strategyId:7,
      instrument:{ tick_size:0.01, point:0.01 },
    })).toBeNull()
  })

  it('exposes a stable risk-rejection reason and compact conflict evidence', () => {
    const error = new DuplicateLivePendingError({ ticket:'7001', limit:0.5, current:4405.68 })
    expect(error).toMatchObject({
      reason:'duplicate_live_pending', code:'duplicate_live_pending',
      classification:'risk_rejection', details:{ ticket:'7001', limit:0.5 },
    })
  })

  it('uses tick/point as a lower bound when ATR is unavailable', () => {
    expect(livePendingPriceTolerance({ atrAnchor:null, dedupPriceAtr:0.05, tickSize:0.1, point:0.01 }))
      .toBe(0.1)
    expect(normalizeLivePendingType({ order_type:'buy', entry_method:'stop_limit' }))
      .toBe('buy_stop_limit')
  })
})
