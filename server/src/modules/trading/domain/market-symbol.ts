export interface TerminalSymbol { symbol: string; description: string; selected: boolean; visible: boolean; trade_mode: number | null; currency_base: string | null; currency_profit: string | null }
export function baseMarketSymbol(item: TerminalSymbol) {
 const name = item.symbol.toUpperCase()
 const base = item.currency_base?.toUpperCase(), quote = item.currency_profit?.toUpperCase()
 if (base && quote && /^[A-Z0-9]{2,8}$/.test(base) && /^[A-Z0-9]{2,8}$/.test(quote) && (name.startsWith(base + quote) || base === 'XAU' || base === 'XAG')) return base + quote
 if (name.startsWith('XAUUSD') || name.startsWith('GOLD')) return 'XAUUSD'
 const pair = name.match(/^(XAU|XAG|EUR|GBP|AUD|NZD|USD|CAD|CHF|JPY|BTC|ETH)(USD|EUR|GBP|AUD|NZD|CAD|CHF|JPY)/)
 return pair ? pair[0] : item.symbol
}
export function resolveMarketSymbol(requested: string, items: TerminalSymbol[]) {
 const exact = items.find(item => item.symbol.toUpperCase() === requested.toUpperCase())
 if (exact) return exact.symbol
 const base = requested.toUpperCase()
 const matches = items.filter(item => item.trade_mode !== 0 && (item.symbol.toUpperCase().startsWith(base) || baseMarketSymbol(item) === base))
 matches.sort((a, b) => Number(b.visible) - Number(a.visible) || Number(b.selected) - Number(a.selected) || a.symbol.length - b.symbol.length || a.symbol.localeCompare(b.symbol))
 return matches[0]?.symbol ?? null
}

// Standard symbols may carry arbitrary broker suffixes; preserve terminal names for execution.
export function matchesMarketSymbol(actual: string, standard: string) {
  return standard.length > 0 && actual.toUpperCase().startsWith(standard.toUpperCase())
}
