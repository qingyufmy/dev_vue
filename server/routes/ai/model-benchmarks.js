import crypto from 'node:crypto'
import { queryAll, queryOne, withTransaction, beijingNow } from '../../db.js'
import { stripBrokerSuffix } from './utils.js'
import { loadPeriodMarketWindow } from './period-market-evidence.js'

const REGIME_ORDER = ['trend_up', 'trend_down', 'reversal_up', 'reversal_down', 'fake_breakout', 'range']
const REGIME_LABELS = {
  trend_up:'单边上涨', trend_down:'单边下跌', reversal_up:'下跌反转',
  reversal_down:'上涨反转', fake_breakout:'假突破', range:'区间震荡',
}
const WINDOW_BARS = 24
const FORWARD_BARS = 12
const MAX_GENERATION_CANDLES = 5000

function parseJson(value, fallback) {
  try { return value == null ? fallback : JSON.parse(value) } catch { return fallback }
}

function sha256(value) {
  return crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!sorted.length) return 0
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function candleRange(rate) {
  return Math.max(0, Number(rate.high) - Number(rate.low))
}

function classifyWindow(window, baselineRange) {
  const first = window[0]
  const last = window.at(-1)
  const highs = window.map(rate => Number(rate.high))
  const lows = window.map(rate => Number(rate.low))
  const high = Math.max(...highs)
  const low = Math.min(...lows)
  const range = Math.max(high - low, 1e-9)
  const netMove = Number(last.close) - Number(first.open)
  const path = window.slice(1).reduce((sum, rate, index) => sum + Math.abs(Number(rate.close) - Number(window[index].close)), 0)
  const efficiency = Math.min(1, Math.abs(netMove) / Math.max(path, 1e-9))
  const middle = Math.floor(window.length / 2)
  const firstMove = Number(window[middle - 1].close) - Number(first.open)
  const secondMove = Number(last.close) - Number(window[middle].open)
  const prior = window.slice(0, -4)
  const priorHigh = Math.max(...prior.map(rate => Number(rate.high)))
  const priorLow = Math.min(...prior.map(rate => Number(rate.low)))
  const tail = window.slice(-4)
  const falseUp = Math.max(...tail.map(rate => Number(rate.high))) > priorHigh && Number(last.close) < priorHigh
  const falseDown = Math.min(...tail.map(rate => Number(rate.low))) < priorLow && Number(last.close) > priorLow
  let regimeType = 'range'
  let strength = 0
  if (falseUp || falseDown) {
    regimeType = 'fake_breakout'
    strength = Math.max(falseUp ? (Math.max(...tail.map(rate => Number(rate.high))) - priorHigh) / range : 0,
      falseDown ? (priorLow - Math.min(...tail.map(rate => Number(rate.low)))) / range : 0) + 0.4
  } else if (firstMove < -range * 0.32 && secondMove > range * 0.38) {
    regimeType = 'reversal_up'
    strength = (Math.abs(firstMove) + Math.abs(secondMove)) / range
  } else if (firstMove > range * 0.32 && secondMove < -range * 0.38) {
    regimeType = 'reversal_down'
    strength = (Math.abs(firstMove) + Math.abs(secondMove)) / range
  } else if (netMove > range * 0.58 && efficiency > 0.28) {
    regimeType = 'trend_up'
    strength = netMove / range + efficiency
  } else if (netMove < -range * 0.58 && efficiency > 0.28) {
    regimeType = 'trend_down'
    strength = Math.abs(netMove) / range + efficiency
  } else {
    strength = (1 - Math.min(1, Math.abs(netMove) / range)) + (1 - efficiency)
  }
  return {
    regime_type:regimeType,
    strength:Number(strength.toFixed(6)),
    metrics:{
      open:Number(first.open), high, low, close:Number(last.close),
      range:Number(range.toFixed(8)), net_move:Number(netMove.toFixed(8)),
      efficiency:Number(efficiency.toFixed(6)), volatility_ratio:Number((range / Math.max(baselineRange, 1e-9)).toFixed(4)),
      false_breakout_direction:falseUp ? 'up' : falseDown ? 'down' : null,
    },
  }
}

export function selectClassicBenchmarkCases(rates, requestedCount = 30) {
  const normalized = [...(rates || [])]
    .filter(rate => Number.isFinite(Number(rate?.time_utc_msc)))
    .sort((a, b) => Number(a.time_utc_msc) - Number(b.time_utc_msc))
  if (normalized.length < WINDOW_BARS + FORWARD_BARS + 1) throw new Error('benchmark_market_data_insufficient')
  const baselineRange = median(normalized.map(candleRange)) * Math.sqrt(WINDOW_BARS)
  const candidates = []
  for (let endIndex = WINDOW_BARS - 1; endIndex < normalized.length - FORWARD_BARS; endIndex += 3) {
    const startIndex = endIndex - WINDOW_BARS + 1
    const window = normalized.slice(startIndex, endIndex + 1)
    const classified = classifyWindow(window, baselineRange)
    const decisionTime = Number(normalized[endIndex].time_utc_msc) + 300_000
    candidates.push({
      ...classified,
      start_time_utc_msc:Number(normalized[startIndex].time_utc_msc),
      decision_time_utc_msc:decisionTime,
      end_time_utc_msc:Number(normalized[endIndex + FORWARD_BARS].time_utc_msc) + 300_000,
    })
  }
  const target = Math.max(6, Math.min(60, Number(requestedCount) || 30))
  const perRegime = Math.ceil(target / REGIME_ORDER.length)
  const selected = []
  const usedTimes = []
  for (const regimeType of REGIME_ORDER) {
    const ranked = candidates.filter(item => item.regime_type === regimeType).sort((a, b) => b.strength - a.strength)
    for (const candidate of ranked) {
      if (selected.filter(item => item.regime_type === regimeType).length >= perRegime) break
      if (usedTimes.some(time => Math.abs(time - candidate.decision_time_utc_msc) < 6 * 3_600_000)) continue
      selected.push(candidate)
      usedTimes.push(candidate.decision_time_utc_msc)
    }
  }
  for (const candidate of candidates.sort((a, b) => b.strength - a.strength)) {
    if (selected.length >= target) break
    if (usedTimes.some(time => Math.abs(time - candidate.decision_time_utc_msc) < 3 * 3_600_000)) continue
    selected.push(candidate)
    usedTimes.push(candidate.decision_time_utc_msc)
  }
  return selected.slice(0, target).sort((a, b) => a.decision_time_utc_msc - b.decision_time_utc_msc)
}

function publicSet(row, cases = null) {
  return {
    id:Number(row.id), set_code:row.set_code, name:row.name, version:Number(row.version),
    symbol:row.symbol, status:row.status, description:row.description,
    case_count:Number(row.case_count || 0), selection_config:parseJson(row.selection_config_json, {}),
    fingerprint:row.fingerprint, created_at:row.created_at, updated_at:row.updated_at,
    cases:cases ? cases.map(item => ({
      id:Number(item.id), case_key:item.case_key, title:item.title, regime_type:item.regime_type,
      regime_label:REGIME_LABELS[item.regime_type] || item.regime_type,
      start_time_utc_msc:Number(item.start_time_utc_msc), decision_time_utc_msc:Number(item.decision_time_utc_msc),
      end_time_utc_msc:Number(item.end_time_utc_msc), tags:parseJson(item.tags_json, []),
      metrics:parseJson(item.metrics_json, {}), sort_order:Number(item.sort_order || 0),
    })) : undefined,
  }
}

export async function listModelBenchmarkSets(symbol = null) {
  const normalizedSymbol = symbol ? stripBrokerSuffix(symbol).toUpperCase() : null
  const rows = await queryAll(`SELECT * FROM ai_market_benchmark_sets
    WHERE status = 'active' ${normalizedSymbol ? 'AND symbol = ?' : ''}
    ORDER BY symbol, version DESC, id DESC`, normalizedSymbol ? [normalizedSymbol] : [])
  return rows.map(row => publicSet(row))
}

export async function getModelBenchmarkSet(setId) {
  const row = await queryOne('SELECT * FROM ai_market_benchmark_sets WHERE id = ? AND status = ?', [Number(setId), 'active'])
  if (!row) throw new Error('benchmark_set_not_found')
  const cases = await queryAll('SELECT * FROM ai_market_benchmark_cases WHERE benchmark_set_id = ? ORDER BY sort_order, id', [Number(setId)])
  return publicSet(row, cases)
}

export async function createClassicBenchmarkSet(userId, payload = {}) {
  const symbol = stripBrokerSuffix(payload.symbol || '').toUpperCase()
  if (!symbol) throw new Error('symbol_required')
  const endUtcMs = Number(payload.end_time_utc_msc || Date.now())
  const startUtcMs = Number(payload.start_time_utc_msc || (endUtcMs - 14 * 86_400_000))
  if (!Number.isFinite(startUtcMs) || !Number.isFinite(endUtcMs) || endUtcMs <= startUtcMs) throw new Error('invalid_benchmark_time_range')
  const loaded = await loadPeriodMarketWindow(userId, symbol, 'M5', startUtcMs, endUtcMs, { alignToPeriodStart:false })
  const rates = loaded.periodRates.slice(-MAX_GENERATION_CANDLES)
  const selected = selectClassicBenchmarkCases(rates, payload.case_count || 30)
  if (selected.length < 6) throw new Error('benchmark_market_regimes_insufficient')
  const setCode = `${symbol.toLowerCase()}-classic-market`
  const latest = await queryOne('SELECT MAX(version) AS version FROM ai_market_benchmark_sets WHERE set_code = ?', [setCode])
  const version = Number(latest?.version || 0) + 1
  const selectionConfig = {
    schema_version:1, timeframe:'M5', requested_case_count:Number(payload.case_count || 30),
    source:loaded.marketMeta?.source || 'mysql_period_cache', source_id:loaded.sourceId || null,
    start_time_utc_msc:startUtcMs, end_time_utc_msc:endUtcMs,
    regime_order:REGIME_ORDER,
  }
  const fingerprint = sha256({ symbol, selectionConfig, cases:selected })
  const name = `${symbol} 经典行情基准集 v${version}`
  const now = beijingNow()
  return withTransaction(async run => {
    const [inserted] = await run(`INSERT INTO ai_market_benchmark_sets
      (set_code, name, version, symbol, status, description, case_count, selection_config_json,
       fingerprint, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`, [
      setCode, name, version, symbol, '覆盖趋势、反转、假突破与震荡的固定多周期模型评估案例',
      selected.length, JSON.stringify(selectionConfig), fingerprint, Number(userId), now, now,
    ])
    const setId = Number(inserted.insertId)
    for (let index = 0; index < selected.length; index += 1) {
      const item = selected[index]
      const caseKey = `${item.regime_type}-${item.decision_time_utc_msc}`
      const title = `${REGIME_LABELS[item.regime_type] || item.regime_type} · ${String(index + 1).padStart(2, '0')}`
      await run(`INSERT INTO ai_market_benchmark_cases
        (benchmark_set_id, case_key, title, regime_type, start_time_utc_msc, decision_time_utc_msc,
         end_time_utc_msc, tags_json, metrics_json, sort_order, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        setId, caseKey, title, item.regime_type, item.start_time_utc_msc, item.decision_time_utc_msc,
        item.end_time_utc_msc, JSON.stringify([REGIME_LABELS[item.regime_type] || item.regime_type, 'M5决策']),
        JSON.stringify(item.metrics), index + 1, now,
      ])
    }
    const [rows] = await run('SELECT * FROM ai_market_benchmark_sets WHERE id = ?', [setId])
    const [cases] = await run('SELECT * FROM ai_market_benchmark_cases WHERE benchmark_set_id = ? ORDER BY sort_order', [setId])
    return publicSet(rows[0], cases)
  })
}

export async function resolveBenchmarkRun(setId, requestedCount = 12) {
  const benchmark = await getModelBenchmarkSet(setId)
  const target = Math.max(4, Math.min(benchmark.cases.length, Number(requestedCount) || 12))
  const buckets = new Map(REGIME_ORDER.map(type => [type, benchmark.cases.filter(item => item.regime_type === type)]))
  const selected = []
  let cursor = 0
  while (selected.length < target && cursor < benchmark.cases.length) {
    for (const type of REGIME_ORDER) {
      const candidate = buckets.get(type)?.[cursor]
      if (candidate && selected.length < target) selected.push(candidate)
    }
    cursor += 1
  }
  const ordered = selected.sort((a, b) => a.decision_time_utc_msc - b.decision_time_utc_msc)
  return {
    benchmark:{ ...benchmark, cases:undefined }, cases:ordered,
    symbol:benchmark.symbol,
    start_time_utc_msc:Math.min(...ordered.map(item => item.start_time_utc_msc)),
    end_time_utc_msc:Math.max(...ordered.map(item => item.end_time_utc_msc)),
    decision_times_utc_msc:ordered.map(item => item.decision_time_utc_msc),
  }
}

export const __modelBenchmarksTest = { classifyWindow, REGIME_ORDER }
