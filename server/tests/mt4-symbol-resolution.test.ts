import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const source = readFileSync('bridge/prototypes/net48-win7/adapters/mt4/BridgeV4MT4.mq4', 'utf8')
const block = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)))
// Run the resolver body itself with MQL string/catalog primitives; this is not an EA compile or terminal test.
const resolver = block('string B4MT4ResolveMarketSymbol(', 'string B4MT4SymbolDescription(')
const body = resolver.slice(resolver.indexOf('{') + 1, resolver.lastIndexOf('}')).replace(/\b(?:string|int) (\w+)/g, 'let $1')
function resolve(requested: string, names: string[]) {
  return new Function('requested', 'SymbolsTotal', 'SymbolName', 'StringLen', 'StringCompare', 'StringSubstr', body)(
    requested, () => names.length, (index: number) => names[index], (value: string) => value.length,
    (a: string, b: string, sensitive = true) => sensitive ? a.localeCompare(b) : a.toUpperCase().localeCompare(b.toUpperCase()),
    (value: string, start: number, length: number) => value.slice(start, start + length),
  )
}
it.each(['XAUUSD', 'XAUUSD.s', 'XAUUSD.c', 'xauusdAnyBrokerSuffix'])('resolves standard requests to %s', actual => {
  expect(resolve('XAUUSD', ['EURUSD', actual])).toBe(actual)
})
it('rejects unrelated, truncated and ambiguous matches while preserving exact terminal targets', () => {
  expect(resolve('XAUUSD', ['EURUSD', 'preXAUUSD', 'XAUUS'])).toBe('')
  expect(resolve('XAUUSD', ['XAUUSD.s', 'XAUUSD.c'])).toBe('')
  expect(resolve('XAUUSD.s', ['XAUUSD.s', 'XAUUSD.c'])).toBe('XAUUSD.s')
  expect(resolve('', ['XAUUSD'])).toBe('')
})
it('resolves new orders and reference lookups without rewriting the frozen command', () => {
  const place = block('void B4MT4ExecutePlace(', 'void B4MT4ExecuteCancel(')
  expect(place).toContain('string symbol = B4MT4ResolveMarketSymbol(requested_symbol)')
  expect(place).toContain('OrderSend(symbol,')
  expect(place).toContain('OrderSymbol() != symbol')
  const lookup = block('void B4MT4ExecuteLookup(', 'void B4MT4HandleCommand(')
  expect(lookup).toContain('string symbol = B4MT4ResolveMarketSymbol(command.symbol)')
  expect(lookup).toContain('OrderMagicNumber() != command.magic')
  expect(lookup).toContain('StringFind(OrderComment(), reference) != 0')
  expect(lookup).not.toContain('command.symbol =')
})
