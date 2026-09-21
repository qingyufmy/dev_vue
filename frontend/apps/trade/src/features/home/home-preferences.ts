import type { Timeframe } from '@aurum/contracts'

export type StructureLayers = { bi: boolean; segment: boolean; trend: boolean; center: boolean; fractal: boolean; levels: boolean }

export interface HomePreferences {
  symbol: string
  timeframe: Timeframe
  layers: StructureLayers
}

export const defaultStructureLayers = (): StructureLayers => ({
  bi: true,
  segment: true,
  trend: true,
  center: true,
  fractal: true,
  levels: true,
})

const timeframes = new Set<Timeframe>(['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'])
const prefix = 'aurum.trade.home.v1'

function key(userId: string, scope: string) {
  return `${prefix}:${encodeURIComponent(userId)}:${encodeURIComponent(scope)}`
}

function normalizeLayers(value: unknown): StructureLayers {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const defaults = defaultStructureLayers()
  return {
    bi: typeof source.bi === 'boolean' ? source.bi : defaults.bi,
    segment: typeof source.segment === 'boolean' ? source.segment : defaults.segment,
    trend: typeof source.trend === 'boolean' ? source.trend : defaults.trend,
    center: typeof source.center === 'boolean' ? source.center : defaults.center,
    fractal: typeof source.fractal === 'boolean' ? source.fractal : defaults.fractal,
    levels: typeof source.levels === 'boolean' ? source.levels : defaults.levels,
  }
}

export function readHomePreferences(storage: Pick<Storage, 'getItem'>, userId: string, scope: string): HomePreferences | null {
  try {
    const raw = storage.getItem(key(userId, scope))
    if (!raw) return null
    const value = JSON.parse(raw) as Record<string, unknown>
    const symbol = typeof value.symbol === 'string' && /^[A-Z0-9]{1,32}$/.test(value.symbol) ? value.symbol : ''
    const timeframe = timeframes.has(value.timeframe as Timeframe) ? value.timeframe as Timeframe : 'M5'
    return { symbol, timeframe, layers: normalizeLayers(value.layers) }
  } catch { return null }
}

export function writeHomePreferences(storage: Pick<Storage, 'setItem'>, userId: string, scope: string, value: HomePreferences) {
  try {
    storage.setItem(key(userId, scope), JSON.stringify({
      symbol: /^[A-Z0-9]{1,32}$/.test(value.symbol) ? value.symbol : '',
      timeframe: timeframes.has(value.timeframe) ? value.timeframe : 'M5',
      layers: normalizeLayers(value.layers),
    }))
  } catch { /* Local persistence is optional; the active page state still works. */ }
}
