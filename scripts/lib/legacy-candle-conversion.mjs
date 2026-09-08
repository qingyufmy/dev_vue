import { hash } from './v4-backfill-contract.mjs'

const check = (ok, code) => { if (!ok) throw Error('legacy_candle_' + code) }
const integer = value => typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)
const numeric = (a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0
const signed = value => ({ ...value, planHash: hash(value) })

// Account mappings supply reviewed terminal-platform evidence. A candle's open
// time is not an account-ownership event; never grant historical access here.
export function planLegacyCandleSources(sources, accounts) {
  check(Array.isArray(sources) && sources.length <= 10000, 'source_budget')
  check(accounts.mappingHash === hash({ entities: accounts.entities, mappings: accounts.mappings, settings: accounts.settings }), 'account_mapping_hash')
  const ids = new Set()
  const mappings = sources.map(source => {
    check(integer(source.id) && source.id !== '0' && !ids.has(source.id), 'source_id'); ids.add(source.id)
    check(integer(source.userId) && source.userId !== '0' && typeof source.server === 'string'
      && source.server.length > 0 && source.server === source.server.trim() && /^[\x20-\x7e]+$/.test(source.server)
      && integer(source.login), 'source_identity')
    const candidates = accounts.entities.filter(account => account.brokerServerKey === source.server.toUpperCase() && account.accountLogin === source.login)
    check(candidates.length === 1, 'source_account_ambiguous')
    const account = candidates[0]
    check(['mt4', 'mt5'].includes(account.platform), 'source_platform')
    const owners = accounts.settings.filter(setting => setting.targetAccountId === account.targetAccountId && setting.userId === source.userId)
    check(owners.length > 0, 'source_owner_unresolved')
    return { sourceId: source.id, targetAccountId: account.targetAccountId, platform: account.platform,
      sourceHash: hash(source), accountCandidateKey: account.candidateKey,
      legacyAccountIds: owners.map(owner => owner.sourceAccountId).sort(numeric) }
  }).sort((a, b) => numeric(a.sourceId, b.sourceId))
  return signed({ kind: 'legacy-candle-source-plan/v1', accountMappingHash: accounts.mappingHash, mappings })
}

function decimal(value, precision, scale) {
  check(typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value), 'decimal_invalid')
  const negative = value.startsWith('-'), unsigned = negative ? value.slice(1) : value
  const [whole, fraction = ''] = unsigned.split('.'), normalized = whole.replace(/^0+(?=\d)/, '')
  check(normalized.length <= precision - scale && fraction.length <= scale, 'decimal_overflow')
  const result = normalized + '.' + fraction.padEnd(scale, '0')
  return negative && /[1-9]/.test(result) ? '-' + result : result
}

export function planLegacyCandleConversion(rows, sourcePlan, basis) {
  const { planHash, ...sourceBody } = sourcePlan
  check(sourcePlan.kind === 'legacy-candle-source-plan/v1' && hash(sourceBody) === planHash, 'source_plan_hash')
  check(basis?.closedPolicy === 'legacy-closed-writer/v1' && basis.symbolPolicy === 'stored-standard-symbol/v1'
    && /^[a-f0-9]{64}$/.test(basis.writerHash) && basis.revision === '1', 'basis')
  check(Array.isArray(rows) && rows.length <= 100000, 'row_budget')
  const sources = new Map(sourcePlan.mappings.map(row => [row.sourceId, row]))
  const keys = new Map(), ids = new Set(), mappings = []
  for (const row of rows) {
    check(integer(row.id) && row.id !== '0' && !ids.has(row.id), 'row_id'); ids.add(row.id)
    const source = sources.get(row.source_id); check(source, 'row_source_unmapped')
    check(typeof row.standard_symbol === 'string' && /^[\x21-\x7e]{1,64}$/.test(row.standard_symbol), 'symbol')
    check(['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'].includes(row.timeframe), 'timeframe')
    check(integer(row.open_time_utc_msc) && BigInt(row.open_time_utc_msc) <= 253402300799999n, 'utc_milliseconds')
    const openTime = new Date(Number(row.open_time_utc_msc)).toISOString()
    check(integer(row.tick_volume), 'tick_volume')
    const target = { trading_account_id: source.targetAccountId, symbol: row.standard_symbol, timeframe: row.timeframe,
      open_time_utc: openTime, open_price: decimal(row.open_price, 24, 10), high_price: decimal(row.high_price, 24, 10),
      low_price: decimal(row.low_price, 24, 10), close_price: decimal(row.close_price, 24, 10),
      tick_volume: decimal(row.tick_volume, 24, 8), closed: true, revision: '1' }
    const key = [target.trading_account_id, target.symbol, target.timeframe, target.open_time_utc]
    const targetKeyHash = hash(key), payloadHash = hash(target), previous = keys.get(targetKeyHash)
    check(!previous || previous.payloadHash === payloadHash, 'duplicate_payload_conflict')
    if (!previous || numeric(row.id, previous.representativeId) < 0) keys.set(targetKeyHash, { targetKeyHash, payloadHash, representativeId: row.id, target })
    mappings.push({ legacyCandleId: row.id, sourceId: row.source_id, targetKeyHash, payloadHash, sourceHash: hash(row) })
  }
  mappings.sort((a, b) => numeric(a.legacyCandleId, b.legacyCandleId))
  const projections = [...keys.values()].sort((a, b) => a.targetKeyHash.localeCompare(b.targetKeyHash))
  const summary = { kind: 'legacy-candle-conversion/v1', sourcePlanHash: sourcePlan.planHash, basis,
    inputRows: rows.length, outputRows: projections.length, duplicateRows: rows.length - projections.length,
    mappingHash: hash(mappings), projectionHash: hash(projections), sourceRowsHash: hash(mappings.map(({ legacyCandleId, sourceHash }) => ({ legacyCandleId, sourceHash }))) }
  return { ...signed(summary), mappings, projections }
}
