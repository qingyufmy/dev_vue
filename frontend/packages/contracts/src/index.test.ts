import { describe, expect, it } from 'vitest'

import { marketCandleSchema, observerChannelSchema, tradingContextSchema, tradingWorkspaceResponseSchema, sessionResponseSchema } from './index'

describe('sessionResponseSchema', () => {
  it('accepts the normalized V4 session envelope', () => {
    const result = sessionResponseSchema.safeParse({
      data: {
        user: { id: 'usr_1', display_name: '量见用户', avatar_url: null },
        app: 'trade',
        permissions: ['trade.read'],
        authenticated_at: '2026-09-03T04:00:00.000Z',
        mfa_level: 'none',
        csrf_token: 'csrf_once_per_session',
      },
      meta: {
        request_id: 'req_1',
        generated_at: '2026-09-03T04:00:00.000Z',
      },
    })

    expect(result.success).toBe(true)
  })

  it('rejects legacy camelCase fields', () => {
    const result = sessionResponseSchema.safeParse({
      data: {
        user: { id: 'usr_1', displayName: '量见用户', avatarUrl: null },
      },
    })

    expect(result.success).toBe(false)
  })
})

describe('trading V4 contracts', () => {
  it('accepts snake_case transport data and exposes typed frontend names', () => {
    expect(tradingContextSchema.parse({ user_id: '7', mode: 'full', account_id: '21', observer_channel_id: null, read_only: false, revision: '3' })).toEqual({ userId: '7', mode: 'full', accountId: '21', observerChannelId: null, readOnly: false, revision: 3 })
    expect(marketCandleSchema.parse({ account_id: '21', symbol: 'XAUUSD', timeframe: 'M5', open_time: '2026-09-03T08:00:00.000Z', open: '1', high: '2', low: '0.5', close: '1.5', tick_volume: '100', closed: false, revision: '8' })).toMatchObject({ accountId: '21', openTime: '2026-09-03T08:00:00.000Z', tickVolume: '100', revision: 8 })
    expect(observerChannelSchema.parse({ id: 'watch-1', display_name: '黄金观摩', source_account_id: '21', active: true })).toEqual({ id: 'watch-1', displayName: '黄金观摩', sourceAccountId: '21', active: true })
  })

  it('rejects legacy or accidental camelCase at the HTTP boundary', () => {
    expect(tradingContextSchema.safeParse({ userId: '7', mode: 'full', accountId: '21', observerChannelId: null, readOnly: false, revision: '3' }).success).toBe(false)
    expect(tradingWorkspaceResponseSchema.safeParse({ data: { pendingOrders: [] }, meta: {} }).success).toBe(false)
  })
})
