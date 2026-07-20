const DEFAULTS = Object.freeze({
  starting_balance: 10_000,
  commission_per_lot: 0,
  slippage_points: 0,
  max_holding_hours: 24,
})

const finite = value => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const clamp = (value, minimum, maximum, fallback) => {
  const parsed = finite(value)
  return parsed == null ? fallback : Math.max(minimum, Math.min(maximum, parsed))
}

const rateTime = rate => {
  const numeric = finite(rate?.time_utc_msc ?? rate?.time_msc)
  if (numeric != null && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric
  const raw = String(rate?.time || '').trim()
  if (!raw) return null
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T')
  const parsed = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized) ? normalized : `${normalized}Z`)
  return Number.isFinite(parsed) ? parsed : null
}

const directionOf = signalType => {
  const normalized = String(signalType || '').toLowerCase()
  if (normalized.startsWith('buy')) return 'buy'
  if (normalized.startsWith('sell')) return 'sell'
  return null
}

const parseUtcTime = value => {
  const raw = String(value || '').trim()
  if (!raw) return null
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T')
  const parsed = Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized) ? normalized : `${normalized}Z`)
  return Number.isFinite(parsed) ? parsed : null
}

function resolveTakeProfit(signal) {
  const tier = [1, 2, 3].includes(Number(signal?.recommended_take_profit_tier))
    ? Number(signal.recommended_take_profit_tier)
    : 1
  const preferred = finite(signal?.[`take_profit_${tier}_price`])
  const fallback = finite(signal?.take_profit_1_price)
  return { tier: preferred && preferred > 0 ? tier : 1, price: preferred && preferred > 0 ? preferred : fallback }
}

export function normalizeBacktestOptions(options = {}) {
  return {
    starting_balance: clamp(options.starting_balance, 100, 1_000_000_000, DEFAULTS.starting_balance),
    commission_per_lot: clamp(options.commission_per_lot, 0, 10_000, DEFAULTS.commission_per_lot),
    slippage_points: clamp(options.slippage_points, 0, 100_000, DEFAULTS.slippage_points),
    max_holding_hours: clamp(options.max_holding_hours, 1, 24 * 30, DEFAULTS.max_holding_hours),
  }
}

export function normalizeBacktestInstrument(instrument = {}) {
  const tickSize = finite(instrument.tick_size)
  const point = finite(instrument.point)
  const tickValue = finite(instrument.tick_value)
  const volumeMin = finite(instrument.volume_min)
  const volumeMax = finite(instrument.volume_max)
  const volumeStep = finite(instrument.volume_step)
  const missing = []
  if (!(tickSize > 0)) missing.push('tick_size')
  if (!(point > 0)) missing.push('point')
  if (!(tickValue > 0)) missing.push('tick_value')
  if (!(volumeMin > 0)) missing.push('volume_min')
  if (!(volumeMax > 0)) missing.push('volume_max')
  if (!(volumeStep > 0)) missing.push('volume_step')
  return {
    valid: missing.length === 0,
    missing,
    name: instrument.name || null,
    digits: Math.max(0, Math.floor(finite(instrument.digits) ?? 2)),
    point,
    tick_size: tickSize,
    tick_value: tickValue,
    contract_size: finite(instrument.contract_size),
    volume_min: volumeMin,
    volume_max: volumeMax,
    volume_step: volumeStep,
    currency_profit: instrument.currency_profit || null,
  }
}

function normalizeIntent(sample, options) {
  const signal = sample?.order_intent || sample?.signal || sample
  const direction = directionOf(signal?.signal_type || sample?.signal_type)
  if (!direction) return null
  const method = String(signal?.entry_method || 'market').toLowerCase()
  const volume = finite(signal?.recommended_volume ?? signal?.volume)
  const sl = finite(signal?.stop_loss_price ?? signal?.sl)
  const tp = resolveTakeProfit(signal)
  const decisionTime = finite(sample?.decision_time_utc_msc) ?? rateTime({ time: sample?.decision_time })
  if (!decisionTime || !(volume > 0) || !(sl > 0) || !(tp.price > 0)) return null
  const explicitExpiry = parseUtcTime(signal?.pending_valid_until)
  const pendingMinutes = clamp(signal?.pending_valid_minutes, 1, 24 * 60, 180)
  return {
    direction,
    method,
    volume,
    stop_loss: sl,
    take_profit: tp.price,
    take_profit_tier: tp.tier,
    trigger_price: finite(signal?.limit_price),
    stop_limit_price: finite(signal?.stop_limit_price),
    decision_time_utc_msc: decisionTime,
    expiry_time_utc_msc: explicitExpiry != null
      ? explicitExpiry
      : decisionTime + pendingMinutes * 60_000,
    horizon_end_utc_msc: decisionTime + options.max_holding_hours * 3_600_000,
  }
}

const rounded = (value, digits = 8) => Number(Number(value || 0).toFixed(digits))

function spreadPrice(candle, instrument) {
  const spreadPoints = Math.max(0, finite(candle?.spread) || 0)
  return spreadPoints * instrument.point
}

function fillEntry(intent, candle, instrument, options, state) {
  const open = finite(candle.open)
  const high = finite(candle.high)
  const low = finite(candle.low)
  if (![open, high, low].every(Number.isFinite)) return null
  const spread = spreadPrice(candle, instrument)
  const slippage = options.slippage_points * instrument.point
  if (intent.method === 'market') {
    return intent.direction === 'buy' ? open + spread + slippage : open - slippage
  }
  if (!(intent.trigger_price > 0)) return null
  if (intent.method === 'limit') {
    const touched = intent.direction === 'buy'
      ? low + spread <= intent.trigger_price
      : high >= intent.trigger_price
    return touched ? intent.trigger_price : null
  }
  if (intent.method === 'stop') {
    const touched = intent.direction === 'buy'
      ? high + spread >= intent.trigger_price
      : low <= intent.trigger_price
    if (!touched) return null
    return intent.direction === 'buy'
      ? intent.trigger_price + slippage
      : intent.trigger_price - slippage
  }
  if (intent.method === 'stop_limit') {
    if (!state.stop_triggered) {
      state.stop_triggered = intent.direction === 'buy'
        ? high + spread >= intent.trigger_price
        : low <= intent.trigger_price
    }
    const limit = intent.stop_limit_price
    if (!state.stop_triggered || !(limit > 0)) return null
    const touched = intent.direction === 'buy' ? low + spread <= limit : high >= limit
    return touched ? limit : null
  }
  return null
}

function detectExit(intent, entryPrice, candle, instrument) {
  const high = finite(candle.high)
  const low = finite(candle.low)
  if (![high, low].every(Number.isFinite)) return null
  const spread = spreadPrice(candle, instrument)
  const askHigh = high + spread
  const askLow = low + spread
  const stopHit = intent.direction === 'buy'
    ? low <= intent.stop_loss
    : askHigh >= intent.stop_loss
  const takeHit = intent.direction === 'buy'
    ? high >= intent.take_profit
    : askLow <= intent.take_profit
  if (stopHit && takeHit) {
    return { price: intent.stop_loss, reason: 'same_bar_stop_first', ambiguous: true }
  }
  if (stopHit) return { price: intent.stop_loss, reason: 'stop_loss', ambiguous: false }
  if (takeHit) return { price: intent.take_profit, reason: 'take_profit', ambiguous: false }
  return null
}

function closeAtHorizon(intent, candle, instrument) {
  const close = finite(candle?.close)
  if (!(close > 0)) return null
  return intent.direction === 'buy' ? close : close + spreadPrice(candle, instrument)
}

function profitForTrade(intent, entryPrice, exitPrice, instrument, options) {
  const priceMove = intent.direction === 'buy' ? exitPrice - entryPrice : entryPrice - exitPrice
  const gross = priceMove / instrument.tick_size * instrument.tick_value * intent.volume
  const commission = options.commission_per_lot * intent.volume
  return { gross: rounded(gross), commission: rounded(commission), net: rounded(gross - commission) }
}

export function simulateSignalReplay(samples = [], candles = [], rawInstrument = {}, rawOptions = {}) {
  const options = normalizeBacktestOptions(rawOptions)
  const instrument = normalizeBacktestInstrument(rawInstrument)
  if (!instrument.valid) {
    return {
      status: 'unavailable',
      reason: 'backtest_instrument_incomplete',
      missing_instrument_fields: instrument.missing,
      options,
    }
  }
  const orderedCandles = [...candles]
    .map(candle => ({ ...candle, _time: rateTime(candle) }))
    .filter(candle => candle._time && [candle.open, candle.high, candle.low, candle.close].map(Number).every(Number.isFinite))
    .sort((a, b) => a._time - b._time)
  if (!orderedCandles.length) return { status: 'unavailable', reason: 'backtest_execution_candles_unavailable', options }

  const trades = []
  let skippedSignals = 0
  const sampleDecisionTime = sample => finite(sample?.decision_time_utc_msc)
    ?? rateTime({ time:sample?.decision_time })
    ?? 0
  for (const sample of [...samples].sort((a, b) => sampleDecisionTime(a) - sampleDecisionTime(b))) {
    const intent = normalizeIntent(sample, options)
    if (!intent) {
      if (['buy', 'sell'].includes(directionOf(sample?.signal_type))) skippedSignals += 1
      continue
    }
    const available = orderedCandles.filter(candle =>
      candle._time >= intent.decision_time_utc_msc && candle._time <= intent.horizon_end_utc_msc)
    if (!available.length) {
      trades.push({ status:'not_evaluated', reason:'future_candles_unavailable', decision_time_utc_msc:intent.decision_time_utc_msc })
      continue
    }
    const entryState = { stop_triggered:false }
    let entryPrice = null
    let entryCandle = null
    let exit = null
    let lastCandle = null
    for (const candle of available) {
      lastCandle = candle
      if (entryPrice == null) {
        if (intent.method !== 'market' && candle._time > intent.expiry_time_utc_msc) break
        entryPrice = fillEntry(intent, candle, instrument, options, entryState)
        if (entryPrice == null) continue
        entryCandle = candle
      }
      exit = detectExit(intent, entryPrice, candle, instrument)
      if (exit) {
        exit.candle = candle
        break
      }
    }
    if (entryPrice == null) {
      trades.push({
        status:'expired', reason:'pending_not_triggered', direction:intent.direction, entry_method:intent.method,
        volume:intent.volume, decision_time_utc_msc:intent.decision_time_utc_msc,
        expiry_time_utc_msc:intent.expiry_time_utc_msc,
      })
      continue
    }
    if (!exit) {
      const horizonPrice = closeAtHorizon(intent, lastCandle, instrument)
      if (!(horizonPrice > 0)) {
        trades.push({ status:'not_evaluated', reason:'exit_price_unavailable', decision_time_utc_msc:intent.decision_time_utc_msc })
        continue
      }
      exit = { price:horizonPrice, reason:'holding_horizon_end', ambiguous:false, candle:lastCandle }
    }
    const pnl = profitForTrade(intent, entryPrice, exit.price, instrument, options)
    trades.push({
      status:'closed',
      direction:intent.direction,
      entry_method:intent.method,
      volume:intent.volume,
      decision_time_utc_msc:intent.decision_time_utc_msc,
      entry_time_utc_msc:entryCandle._time,
      exit_time_utc_msc:exit.candle._time,
      entry_price:rounded(entryPrice),
      exit_price:rounded(exit.price),
      stop_loss:intent.stop_loss,
      take_profit:intent.take_profit,
      take_profit_tier:intent.take_profit_tier,
      exit_reason:exit.reason,
      same_bar_ambiguous:exit.ambiguous,
      gross_profit:pnl.gross,
      commission:pnl.commission,
      net_profit:pnl.net,
    })
  }

  const closed = trades.filter(trade => trade.status === 'closed')
  let balance = options.starting_balance
  let peak = balance
  let maxDrawdown = 0
  let maxDrawdownPct = 0
  const equityCurve = [{ time_utc_msc:null, balance:rounded(balance), drawdown:0, drawdown_pct:0 }]
  for (const trade of closed.sort((a, b) => a.exit_time_utc_msc - b.exit_time_utc_msc)) {
    balance += trade.net_profit
    peak = Math.max(peak, balance)
    const drawdown = peak - balance
    const drawdownPct = peak > 0 ? drawdown / peak * 100 : 0
    maxDrawdown = Math.max(maxDrawdown, drawdown)
    maxDrawdownPct = Math.max(maxDrawdownPct, drawdownPct)
    equityCurve.push({
      time_utc_msc:trade.exit_time_utc_msc,
      balance:rounded(balance),
      drawdown:rounded(drawdown),
      drawdown_pct:rounded(drawdownPct, 4),
    })
  }
  const wins = closed.filter(trade => trade.net_profit > 0)
  const losses = closed.filter(trade => trade.net_profit < 0)
  const grossProfit = wins.reduce((sum, trade) => sum + trade.net_profit, 0)
  const grossLoss = Math.abs(losses.reduce((sum, trade) => sum + trade.net_profit, 0))
  const netProfit = closed.reduce((sum, trade) => sum + trade.net_profit, 0)
  return {
    status:'success',
    simulation_mode:'isolated_signal_replay',
    realism_level:'ohlc_execution_no_margin',
    execution_resolution:null,
    options,
    instrument,
    starting_balance:rounded(options.starting_balance),
    ending_balance:rounded(balance),
    net_profit:rounded(netProfit),
    return_pct:rounded(netProfit / options.starting_balance * 100, 4),
    closed_trade_count:closed.length,
    win_count:wins.length,
    loss_count:losses.length,
    win_rate:closed.length ? rounded(wins.length / closed.length * 100, 2) : 0,
    profit_factor:grossLoss > 0 ? rounded(grossProfit / grossLoss, 4) : grossProfit > 0 ? null : 0,
    max_drawdown:rounded(maxDrawdown),
    max_drawdown_pct:rounded(maxDrawdownPct, 4),
    expired_order_count:trades.filter(trade => trade.status === 'expired').length,
    not_evaluated_count:trades.filter(trade => trade.status === 'not_evaluated').length,
    ambiguous_bar_count:closed.filter(trade => trade.same_bar_ambiguous).length,
    skipped_signal_count:skippedSignals,
    trades,
    equity_curve:equityCurve,
  }
}
