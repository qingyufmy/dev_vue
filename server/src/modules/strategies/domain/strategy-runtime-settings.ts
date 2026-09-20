import { parseStandardMarketSymbols } from '../../../shared/standard-market-symbols.js'
import { StrategyAccessError } from './strategy.js'

export function strategyRuntimeSettings(config: Record<string, unknown>) {
  const symbols = config.symbols === undefined ? undefined : parseStandardMarketSymbols(config.symbols)
  const model = config.model_profile_id
  if (model !== undefined && model !== null && (typeof model !== 'string' || !/^[1-9]\d{0,19}$/.test(model))) throw new Error('strategy_model_invalid')
  return { ...(symbols === undefined ? {} : { symbols }), ...(model === undefined ? {} : { model_profile_id: model as string | null }) }
}

export function assertStrategySymbol(config: Record<string, unknown>, symbol: string) {
  const { symbols } = strategyRuntimeSettings(config)
  if (symbols?.length && !symbols.includes(symbol)) throw new StrategyAccessError('strategy_symbol_unsupported', 422)
}
