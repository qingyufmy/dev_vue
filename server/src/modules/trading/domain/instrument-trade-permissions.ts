export interface InstrumentTradePermissions {
  tradeEnabled: boolean
  allowedOpenSides: Array<'buy' | 'sell'>
}

/** ENUM_SYMBOL_TRADE_MODE: disabled=0, long=1, short=2, close=3, full=4. */
export function instrumentTradePermissions(value: Record<string, unknown>): InstrumentTradePermissions {
  const disabled: InstrumentTradePermissions = { tradeEnabled: false, allowedOpenSides: [] }
  if (value.tradeEnabled === false) return disabled
  const raw = value.trade_mode
  // Older normalized snapshots explicitly carried only this flag.
  if (raw === undefined) return value.tradeEnabled === true ? { tradeEnabled: true, allowedOpenSides: ['buy', 'sell'] } : disabled
  const names: Record<string, number> = { disabled: 0, long_only: 1, short_only: 2, close_only: 3, full: 4, enabled: 4 }
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : null
  const mode = typeof raw === 'number' ? raw : text !== null && /^[0-4]$/.test(text) ? Number(text) : text !== null ? names[text] : undefined
  if (mode === 1) return { tradeEnabled: true, allowedOpenSides: ['buy'] }
  if (mode === 2) return { tradeEnabled: true, allowedOpenSides: ['sell'] }
  if (mode === 3) return { tradeEnabled: true, allowedOpenSides: [] }
  if (mode === 4) return { tradeEnabled: true, allowedOpenSides: ['buy', 'sell'] }
  return disabled
}
