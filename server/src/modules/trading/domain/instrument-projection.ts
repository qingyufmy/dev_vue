import { instrumentTradePermissions } from './instrument-trade-permissions.js'

export interface NormalizedInstrument {
  symbol: string
  point: string
  tickSize: string
  tickValue: string
  volumeMin: string
  volumeMax: string
  volumeStep: string
  tradeEnabled: boolean
  allowedOpenSides: Array<'buy' | 'sell'>
  trade_mode: number
}

/** Normalize received numeric representation, never claim to recover precision lost by a terminal adapter. */
function decimal(value: unknown): string {
  let text: string
  if (typeof value === 'string') text = value
  else if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER) {
    text = String(value)
    const exponent = /^(\d+)(?:\.(\d+))?e-(\d+)$/.exec(text)
    if (exponent) {
      const places = Number(exponent[3])
      if (places > 18) invalid()
      const digits = exponent[1]! + (exponent[2] ?? '')
      const offset = exponent[1]!.length - places
      text = offset <= 0 ? `0.${'0'.repeat(-offset)}${digits}` : `${digits.slice(0, offset)}.${digits.slice(offset)}`
    }
  } else return invalid()
  if (!/^(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$/.test(text)) invalid()
  return text
}
function fixed(value: string): bigint {
  const [whole, fraction = ''] = value.split('.')
  return BigInt(whole!) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'))
}
function invalid(): never { throw new Error('instrument_projection_invalid') }

/** MT4 returns symbol; MT5 symbol_snapshot returns name. Neither is a canonical-symbol alias lookup. */
export function normalizeInstrumentProjection(raw: Record<string, unknown>, requestedSymbol: string): NormalizedInstrument {
  if (!requestedSymbol || requestedSymbol.length > 64 || requestedSymbol.trim() !== requestedSymbol) invalid()
  const symbols = [raw.symbol, raw.name].filter(value => value !== undefined)
  if (symbols.length === 0 || symbols.some(value => value !== requestedSymbol)) invalid()
  const mode = raw.trade_mode
  if (typeof mode !== 'number' || !Number.isInteger(mode) || mode < 0 || mode > 4) invalid()
  const point = decimal(raw.point), tickSize = decimal(raw.tick_size), tickValue = decimal(raw.tick_value)
  const volumeMin = decimal(raw.volume_min), volumeMax = decimal(raw.volume_max), volumeStep = decimal(raw.volume_step)
  if ([point, tickSize, volumeMin, volumeMax, volumeStep].some(value => fixed(value) <= 0n)
    || fixed(volumeMax) < fixed(volumeMin) || fixed(volumeStep) > fixed(volumeMax)) invalid()
  return { symbol: requestedSymbol, point, tickSize, tickValue, volumeMin, volumeMax, volumeStep,
    trade_mode: mode, ...instrumentTradePermissions({ trade_mode: mode }) }
}
