import { hash } from './v4-backfill-contract.mjs'

const knownSuffix = /^([A-Z0-9]{4,12})\.(?:a|s|c|pro|std|z|ecn|m|raw|mini)$/i
const genericSuffix = /^([A-Z0-9]{6,12})\.[A-Z0-9_-]{1,16}$/i
const unique = values => [...new Set(values)]
const upper = value => value.trim().toUpperCase()
const dispatchSymbol = value => knownSuffix.exec(upper(value))?.[1] ?? genericSuffix.exec(upper(value))?.[1] ?? upper(value)

// Preserve both legacy paths: scheduler/config.resolveEffectiveSymbols keeps
// suffixes; admin dispatch additionally strips broker suffixes. A disagreement
// cannot silently choose a broader set of executable instruments.
export function convertSubscriptionSymbols(selectedJson, strategyJson) {
  const sourceHash = hash({ selectedJson, strategyJson })
  const selectionMode = selectedJson === null ? 'inherit_strategy' : 'explicit'
  const problems = []
  const parse = (value, field) => {
    try {
      if (typeof value !== 'string') throw new Error()
      const parsed = JSON.parse(value)
      if (!Array.isArray(parsed) || parsed.some(item => typeof item !== 'string' || !item.trim())) throw new Error()
      return parsed
    } catch { problems.push({ code: 'subscription_symbol_source_invalid', field }); return null }
  }
  const strategy = parse(strategyJson, 'strategy_symbols_json')
  const selected = selectedJson === null ? null : parse(selectedJson, 'symbols_json')
  if (problems.length) return { sourceHash, selectionMode, status: 'blocked', problems, symbols: null, schedulerSymbols: null, dispatchSymbols: null }
  const resolve = normalize => {
    const allowed = unique(strategy.map(normalize))
    return selected === null ? allowed : unique(selected.map(normalize)).filter(symbol => allowed.includes(symbol))
  }
  const schedulerSymbols = resolve(upper)
  const dispatchSymbols = resolve(dispatchSymbol)
  // Compare normalized scheduler instruments with dispatch instruments, while
  // retaining both original result sets for independent reconciliation.
  const normalizedScheduler = unique(schedulerSymbols.map(dispatchSymbol)).sort()
  if (JSON.stringify(normalizedScheduler) !== JSON.stringify([...dispatchSymbols].sort())) problems.push({ code: 'legacy_symbol_paths_disagree', field: 'symbols_json' })
  const candidates = [...dispatchSymbols].sort()
  if (candidates.some(symbol => !/^[A-Z0-9][A-Z0-9._-]{0,63}$/.test(symbol))) problems.push({ code: 'subscription_symbol_target_invalid', field: 'symbols_json' })
  return { sourceHash, selectionMode, status: problems.length ? 'blocked' : 'converted', problems,
    symbols: problems.length ? null : candidates, schedulerSymbols, dispatchSymbols }
}
