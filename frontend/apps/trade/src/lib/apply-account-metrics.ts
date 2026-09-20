import { accountMetricsUpdateSchema, type AccountSnapshot } from '@aurum/contracts'

export function applyAccountMetrics(snapshot: AccountSnapshot, data: unknown, revision: number): AccountSnapshot {
  const parsed = accountMetricsUpdateSchema.safeParse(data)
  if (!parsed.success || !Number.isSafeInteger(revision) || revision <= snapshot.revision) return snapshot
  const update = parsed.data
  return {
    ...snapshot, balance: update.balance, equity: update.equity, margin: update.margin,
    freeMargin: update.free_margin, floatingProfit: update.floating_profit, currency: update.currency,
    observedAt: update.observed_at, lastSeenAt: update.observed_at, revision,
    ...(update.leverage === undefined ? {} : { leverage: update.leverage }),
    ...(update.trade_permission === undefined ? {} : { tradePermission: update.trade_permission }),
    // Older producers omit both fields. Explicit null from a new producer clears the offset.
    ...(update.clock_status === undefined ? {} : {
      timezoneOffsetMinutes: update.timezone_offset_minutes!, clockStatus: update.clock_status,
    }),
  }
}
