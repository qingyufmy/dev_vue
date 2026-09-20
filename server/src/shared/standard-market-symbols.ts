/** Administrator catalog contains base symbols, never broker-specific suffixes. */
export function parseStandardMarketSymbols(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 32 || value.some(symbol => typeof symbol !== 'string'
    || !/^[A-Z0-9]{1,32}$/.test(symbol)) || new Set(value).size !== value.length) throw new Error('market_symbols_invalid')
  return [...value] as string[]
}
