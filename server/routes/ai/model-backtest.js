const DEFAULTS = Object.freeze({
  starting_balance: 10_000,
  commission_per_lot: 0,
  slippage_points: 0,
  max_holding_hours: 24,
  leverage: 100,
  stop_out_level_pct: 50,
  max_concurrent_positions: 5,
  max_pending_orders: 20,
  market_entry_ttl_minutes: 5,
  timezone_offset_minutes: 0,
  account_currency: '',
  apply_swap: true,
})

const finite = value => {
  if (value == null || value === '') return null
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
    leverage:clamp(options.leverage, 1, 5000, DEFAULTS.leverage),
    stop_out_level_pct:clamp(options.stop_out_level_pct, 0, 1000, DEFAULTS.stop_out_level_pct),
    max_concurrent_positions:Math.round(clamp(options.max_concurrent_positions, 1, 100, DEFAULTS.max_concurrent_positions)),
    max_pending_orders:Math.round(clamp(options.max_pending_orders, 1, 1000, DEFAULTS.max_pending_orders)),
    market_entry_ttl_minutes:clamp(options.market_entry_ttl_minutes, 1, 1440, DEFAULTS.market_entry_ttl_minutes),
    timezone_offset_minutes:clamp(options.timezone_offset_minutes, -14 * 60, 14 * 60, DEFAULTS.timezone_offset_minutes),
    account_currency:String(options.account_currency || DEFAULTS.account_currency).trim().toUpperCase(),
    apply_swap:options.apply_swap !== false,
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
    trade_mode:finite(instrument.trade_mode),
    trade_exemode:finite(instrument.trade_exemode),
    trade_stops_level:Math.max(0, finite(instrument.trade_stops_level) || 0),
    trade_freeze_level:Math.max(0, finite(instrument.trade_freeze_level) || 0),
    filling_mode:finite(instrument.filling_mode),
    order_mode:finite(instrument.order_mode),
    spread:Math.max(0, finite(instrument.spread) || 0),
    spread_float:Boolean(instrument.spread_float),
    volume_min: volumeMin,
    volume_max: volumeMax,
    volume_step: volumeStep,
    volume_limit:Math.max(0, finite(instrument.volume_limit) || 0),
    currency_base:instrument.currency_base || null,
    currency_profit: instrument.currency_profit || null,
    currency_margin:instrument.currency_margin || null,
    margin_initial:finite(instrument.margin_initial),
    margin_maintenance:finite(instrument.margin_maintenance),
    margin_hedged:finite(instrument.margin_hedged),
    trade_calc_mode:finite(instrument.trade_calc_mode),
    swap_mode:finite(instrument.swap_mode),
    swap_rollover3days:finite(instrument.swap_rollover3days),
    swap_long:finite(instrument.swap_long),
    swap_short:finite(instrument.swap_short),
    swap_daily_multipliers:[
      finite(instrument.swap_sunday),
      finite(instrument.swap_monday),
      finite(instrument.swap_tuesday),
      finite(instrument.swap_wednesday),
      finite(instrument.swap_thursday),
      finite(instrument.swap_friday),
      finite(instrument.swap_saturday),
    ],
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
  const candleSpread = finite(candle?.spread)
  const spreadPoints = Math.max(0, candleSpread == null ? instrument.spread || 0 : candleSpread)
  return spreadPoints * instrument.point
}

function brokerOrderViolation(intent, candle, instrument, pending = [], positions = []) {
  const tradeMode = instrument.trade_mode
  if (tradeMode === 0 || tradeMode === 3) return 'symbol_not_open_for_new_positions'
  if (tradeMode === 1 && intent.direction !== 'buy') return 'symbol_long_only'
  if (tradeMode === 2 && intent.direction !== 'sell') return 'symbol_short_only'
  if (instrument.order_mode != null) {
    const requiredOrderFlag = intent.method === 'market' ? 1
      : intent.method === 'limit' ? 2
        : intent.method === 'stop' ? 4
          : intent.method === 'stop_limit' ? 8
            : 0
    if (!requiredOrderFlag || (instrument.order_mode & requiredOrderFlag) === 0) return 'entry_method_not_allowed'
    if ((instrument.order_mode & 16) === 0) return 'stop_loss_not_allowed'
    if ((instrument.order_mode & 32) === 0) return 'take_profit_not_allowed'
  }

  const volumeTolerance = Math.max(1e-9, instrument.volume_step * 1e-6)
  if (intent.volume < instrument.volume_min - volumeTolerance
    || intent.volume > instrument.volume_max + volumeTolerance) {
    return 'volume_out_of_range'
  }
  const volumeSteps = (intent.volume - instrument.volume_min) / instrument.volume_step
  if (Math.abs(volumeSteps - Math.round(volumeSteps)) > 1e-6) return 'volume_step_mismatch'
  if (instrument.volume_limit > 0) {
    const directionalExposure = [...pending, ...positions]
      .filter(item => item.direction === intent.direction)
      .reduce((sum, item) => sum + Number(item.volume || 0), 0)
    if (directionalExposure + intent.volume > instrument.volume_limit + volumeTolerance) {
      return 'directional_volume_limit_exceeded'
    }
  }

  const minimumDistance = instrument.trade_stops_level * instrument.point
  if (!(minimumDistance > 0)) return null
  const bid = finite(candle?.open)
  if (!(bid > 0)) return 'reference_quote_unavailable'
  const ask = bid + spreadPrice(candle, instrument)
  const entryReference = intent.method === 'market'
    ? (intent.direction === 'buy' ? ask : bid)
    : intent.method === 'stop_limit'
      ? intent.stop_limit_price
      : intent.trigger_price
  if (!(entryReference > 0)) return 'entry_reference_invalid'

  if (intent.method === 'limit') {
    if (intent.direction === 'buy' && ask - intent.trigger_price < minimumDistance - 1e-9) return 'pending_price_too_close'
    if (intent.direction === 'sell' && intent.trigger_price - bid < minimumDistance - 1e-9) return 'pending_price_too_close'
  }
  if (intent.method === 'stop' || intent.method === 'stop_limit') {
    if (intent.direction === 'buy' && intent.trigger_price - ask < minimumDistance - 1e-9) return 'pending_price_too_close'
    if (intent.direction === 'sell' && bid - intent.trigger_price < minimumDistance - 1e-9) return 'pending_price_too_close'
  }
  if (intent.direction === 'buy') {
    if (entryReference - intent.stop_loss < minimumDistance - 1e-9) return 'stop_loss_too_close'
    if (intent.take_profit - entryReference < minimumDistance - 1e-9) return 'take_profit_too_close'
  } else {
    if (intent.stop_loss - entryReference < minimumDistance - 1e-9) return 'stop_loss_too_close'
    if (entryReference - intent.take_profit < minimumDistance - 1e-9) return 'take_profit_too_close'
  }
  return null
}

function fillEntry(intent, candle, instrument, options, state) {
  const open = finite(candle.open)
  const high = finite(candle.high)
  const low = finite(candle.low)
  if (![open, high, low].every(Number.isFinite)) return null
  const spread = spreadPrice(candle, instrument)
  const slippage = options.slippage_points * instrument.point
  const askOpen = open + spread
  const askHigh = high + spread
  const askLow = low + spread
  if (intent.method === 'market') {
    return intent.direction === 'buy' ? askOpen + slippage : open - slippage
  }
  if (!(intent.trigger_price > 0)) return null
  if (intent.method === 'limit') {
    if (intent.direction === 'buy') {
      if (askOpen <= intent.trigger_price) return askOpen
      return askLow <= intent.trigger_price ? intent.trigger_price : null
    }
    if (open >= intent.trigger_price) return open
    return high >= intent.trigger_price ? intent.trigger_price : null
  }
  if (intent.method === 'stop') {
    if (intent.direction === 'buy') {
      if (askOpen >= intent.trigger_price) return askOpen + slippage
      return askHigh >= intent.trigger_price ? intent.trigger_price + slippage : null
    }
    if (open <= intent.trigger_price) return open - slippage
    return low <= intent.trigger_price ? intent.trigger_price - slippage : null
  }
  if (intent.method === 'stop_limit') {
    state.stop_limit_deferred_this_bar = false
    if (!state.stop_triggered) {
      const triggeredAtOpen = intent.direction === 'buy'
        ? askOpen >= intent.trigger_price
        : open <= intent.trigger_price
      const triggeredIntrabar = intent.direction === 'buy'
        ? askHigh >= intent.trigger_price
        : low <= intent.trigger_price
      state.stop_triggered = triggeredAtOpen || triggeredIntrabar
      if (state.stop_triggered) state.stop_triggered_time_utc_msc = candle._time
      // If activation and the limit touch both occur inside one OHLC candle,
      // their order is unknowable. Defer the fill to the next candle instead
      // of assuming the profitable sequence.
      if (state.stop_triggered && !triggeredAtOpen) {
        state.stop_limit_deferred_this_bar = true
        return null
      }
    }
    const limit = intent.stop_limit_price
    if (!state.stop_triggered || !(limit > 0)) return null
    if (intent.direction === 'buy') {
      if (askOpen <= limit) return askOpen
      return askLow <= limit ? limit : null
    }
    if (open >= limit) return open
    return high >= limit ? limit : null
  }
  return null
}

function detectExit(intent, entryPrice, candle, instrument, options = null) {
  const open = finite(candle.open)
  const high = finite(candle.high)
  const low = finite(candle.low)
  if (![open, high, low].every(Number.isFinite)) return null
  const spread = spreadPrice(candle, instrument)
  const slippage = options ? options.slippage_points * instrument.point : 0
  const askOpen = open + spread
  const askHigh = high + spread
  const askLow = low + spread
  const stopHit = intent.direction === 'buy'
    ? low <= intent.stop_loss
    : askHigh >= intent.stop_loss
  const takeHit = intent.direction === 'buy'
    ? high >= intent.take_profit
    : askLow <= intent.take_profit
  const stopPrice = intent.direction === 'buy'
    ? (open <= intent.stop_loss ? open : intent.stop_loss) - slippage
    : (askOpen >= intent.stop_loss ? askOpen : intent.stop_loss) + slippage
  const takePrice = intent.direction === 'buy'
    ? (open >= intent.take_profit ? open : intent.take_profit)
    : (askOpen <= intent.take_profit ? askOpen : intent.take_profit)
  if (stopHit && takeHit) {
    return { price: stopPrice, reason: 'same_bar_stop_first', ambiguous: true }
  }
  if (stopHit) return { price: stopPrice, reason: 'stop_loss', ambiguous: false }
  if (takeHit) return { price: takePrice, reason: 'take_profit', ambiguous: false }
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

function markPrice(direction, candle, instrument) {
  const close = finite(candle?.close)
  if (!(close > 0)) return null
  return direction === 'buy' ? close : close + spreadPrice(candle, instrument)
}

function grossProfit(direction, volume, entryPrice, exitPrice, instrument) {
  const move = direction === 'buy' ? exitPrice - entryPrice : entryPrice - exitPrice
  return rounded(move / instrument.tick_size * instrument.tick_value * volume)
}

const DAY_MS = 24 * 60 * 60 * 1000

function rolloverEvents(previousUtcMs, currentUtcMs, timezoneOffsetMinutes) {
  if (!(currentUtcMs > previousUtcMs)) return []
  const offsetMs = timezoneOffsetMinutes * 60_000
  const previousServerMs = previousUtcMs + offsetMs
  const currentServerMs = currentUtcMs + offsetMs
  let boundaryServerMs = (Math.floor(previousServerMs / DAY_MS) + 1) * DAY_MS
  const events = []
  while (boundaryServerMs <= currentServerMs) {
    const rolloverFromDay = new Date(boundaryServerMs - DAY_MS).getUTCDay()
    events.push({
      time_utc_msc:boundaryServerMs - offsetMs,
      rollover_from_day:rolloverFromDay,
    })
    boundaryServerMs += DAY_MS
  }
  return events
}

function swapMultiplier(instrument, rolloverFromDay) {
  const explicit = instrument.swap_daily_multipliers?.[rolloverFromDay]
  if (explicit != null) return explicit
  if (rolloverFromDay === 0 || rolloverFromDay === 6) return 0
  return rolloverFromDay === instrument.swap_rollover3days ? 3 : 1
}

function profitCurrencyRate(instrument) {
  if (!(instrument.contract_size > 0) || !(instrument.tick_size > 0) || !(instrument.tick_value > 0)) return null
  return instrument.tick_value / (instrument.tick_size * instrument.contract_size)
}

function currencyToDepositRate(currency, price, instrument, options) {
  const requested = String(currency || '').toUpperCase()
  if (!requested || !options.account_currency) return null
  if (requested === options.account_currency) return 1
  const profitRate = profitCurrencyRate(instrument)
  if (!(profitRate > 0)) return null
  if (requested === String(instrument.currency_profit || '').toUpperCase()) return profitRate
  if (requested === String(instrument.currency_base || '').toUpperCase() && price > 0) return price * profitRate
  if (requested === String(instrument.currency_margin || '').toUpperCase()) {
    if (requested === String(instrument.currency_base || '').toUpperCase() && price > 0) return price * profitRate
    if (requested === String(instrument.currency_profit || '').toUpperCase()) return profitRate
  }
  return null
}

function swapCharge(position, candle, instrument, options, multiplier) {
  if (!options.apply_swap || multiplier === 0 || instrument.swap_mode === 0) return { amount:0, status:'ready' }
  const swapValue = position.direction === 'buy' ? instrument.swap_long : instrument.swap_short
  if (swapValue == null || instrument.swap_mode == null) return { amount:null, status:'metadata_unavailable' }
  const price = markPrice(position.direction, candle, instrument)
  if (!(price > 0)) return { amount:null, status:'price_unavailable' }
  let amountPerLot = null
  if ([1, 7, 8].includes(instrument.swap_mode)) {
    amountPerLot = swapValue * instrument.point / instrument.tick_size * instrument.tick_value
  } else if (instrument.swap_mode === 2) {
    const rate = currencyToDepositRate(instrument.currency_base, price, instrument, options)
    if (rate != null) amountPerLot = swapValue * rate
  } else if (instrument.swap_mode === 3) {
    const rate = currencyToDepositRate(instrument.currency_margin, price, instrument, options)
    if (rate != null) amountPerLot = swapValue * rate
  } else if (instrument.swap_mode === 4) {
    amountPerLot = swapValue
  } else if (instrument.swap_mode === 9) {
    const rate = currencyToDepositRate(instrument.currency_profit, price, instrument, options)
    if (rate != null) amountPerLot = swapValue * rate
  } else if ([5, 6].includes(instrument.swap_mode)) {
    const interestPrice = instrument.swap_mode === 6 ? position.entry_price : price
    const rate = currencyToDepositRate(instrument.currency_profit, interestPrice, instrument, options)
    if (rate != null && instrument.contract_size > 0) {
      amountPerLot = interestPrice * instrument.contract_size * (swapValue / 100) / 360 * rate
    }
  }
  if (amountPerLot == null) return { amount:null, status:'currency_conversion_unavailable' }
  return { amount:rounded(amountPerLot * position.volume * multiplier), status:'ready' }
}

function requiredMargin(volume, entryPrice, instrument, options) {
  if (instrument.margin_initial > 0) return rounded(instrument.margin_initial * volume)
  if (!(instrument.contract_size > 0) || !(options.leverage > 0)) return null
  return rounded(entryPrice * instrument.contract_size * volume / options.leverage)
}

function adverseMarkPrice(direction, candle, instrument) {
  const low = finite(candle?.low)
  const high = finite(candle?.high)
  if (!(low > 0) || !(high > 0)) return null
  return direction === 'buy' ? low : high + spreadPrice(candle, instrument)
}

function summarizeAccount(balance, positions, candle, instrument, priceResolver = markPrice) {
  let floating = 0
  let margin = 0
  for (const position of positions) {
    const price = priceResolver(position.direction, candle, instrument)
    if (price != null) floating += grossProfit(position.direction, position.volume, position.entry_price, price, instrument)
    margin += position.margin
  }
  const equity = balance + floating
  const freeMargin = equity - margin
  return {
    balance:rounded(balance),
    equity:rounded(equity),
    floating_profit:rounded(floating),
    margin:rounded(margin),
    free_margin:rounded(freeMargin),
    margin_level_pct:margin > 0 ? rounded(equity / margin * 100, 4) : null,
  }
}

function closeVirtualPosition(position, exitPrice, exitTime, reason, ambiguous, balance, options, instrument) {
  const gross = grossProfit(position.direction, position.volume, position.entry_price, exitPrice, instrument)
  const exitCommission = rounded(options.commission_per_lot * position.volume / 2)
  const totalCommission = rounded(position.entry_commission + exitCommission)
  const swap = rounded(position.swap || 0)
  const net = rounded(gross - totalCommission + swap)
  return {
    balance:rounded(balance + gross - exitCommission),
    trade:{
      status:'closed',
      position_id:position.id,
      signal_index:position.signal_index,
      direction:position.direction,
      entry_method:position.entry_method,
      volume:position.volume,
      decision_time_utc_msc:position.decision_time_utc_msc,
      entry_time_utc_msc:position.entry_time_utc_msc,
      exit_time_utc_msc:exitTime,
      entry_price:position.entry_price,
      exit_price:rounded(exitPrice),
      stop_loss:position.stop_loss,
      take_profit:position.take_profit,
      take_profit_tier:position.take_profit_tier,
      exit_reason:reason,
      same_bar_ambiguous:Boolean(ambiguous),
      margin:position.margin,
      gross_profit:gross,
      commission:totalCommission,
      swap,
      net_profit:net,
    },
  }
}

function compactEquityCurve(points, maximum = 600) {
  if (points.length <= maximum) return points
  const lastIndex = points.length - 1
  const indexes = new Set([0, lastIndex])
  for (let index = 1; index < maximum - 1; index += 1) {
    indexes.add(Math.round(index * lastIndex / (maximum - 1)))
  }
  return [...indexes].sort((a, b) => a - b).map(index => points[index])
}

export function simulateVirtualAccount(samples = [], candles = [], rawInstrument = {}, rawOptions = {}) {
  const options = normalizeBacktestOptions(rawOptions)
  const instrument = normalizeBacktestInstrument(rawInstrument)
  if (!instrument.valid || !(instrument.contract_size > 0 || instrument.margin_initial > 0)) {
    const missing = [...instrument.missing]
    if (!(instrument.contract_size > 0 || instrument.margin_initial > 0)) missing.push('contract_size_or_margin_initial')
    return {
      status:'unavailable',
      reason:'backtest_instrument_incomplete',
      missing_instrument_fields:[...new Set(missing)],
      options,
    }
  }
  const orderedCandles = [...candles]
    .map(candle => ({ ...candle, _time:rateTime(candle) }))
    .filter(candle => candle._time && [candle.open, candle.high, candle.low, candle.close].map(Number).every(Number.isFinite))
    .sort((a, b) => a._time - b._time)
  if (!orderedCandles.length) {
    return { status:'unavailable', reason:'backtest_execution_candles_unavailable', options }
  }

  const intents = []
  let skippedSignals = 0
  for (let index = 0; index < samples.length; index += 1) {
    const normalized = normalizeIntent(samples[index], options)
    if (normalized) intents.push({ ...normalized, signal_index:index, state:{ stop_triggered:false } })
    else if (directionOf(samples[index]?.signal_type)) skippedSignals += 1
  }
  intents.sort((a, b) => a.decision_time_utc_msc - b.decision_time_utc_msc)

  const pending = []
  const positions = []
  const records = []
  const rawCurve = []
  let intentIndex = 0
  let nextPositionId = 1
  let balance = options.starting_balance
  let peakEquity = balance
  let maximumDrawdown = 0
  let maximumDrawdownPct = 0
  let lowestMarginLevel = null
  let maximumConcurrentPositions = 0
  let stopOutCount = 0
  let marginRejectedCount = 0
  let positionLimitRejectedCount = 0
  let pendingLimitRejectedCount = 0
  let stopLimitDeferredCount = 0
  let brokerConstraintRejectedCount = 0
  let previousCandle = null
  let totalSwap = 0
  let swapRolloverCount = 0
  let swapUnappliedRolloverCount = 0

  const recordAccount = (candle, event = null) => {
    const account = summarizeAccount(balance, positions, candle, instrument)
    peakEquity = Math.max(peakEquity, account.equity)
    const drawdown = Math.max(0, peakEquity - account.equity)
    const drawdownPct = peakEquity > 0 ? drawdown / peakEquity * 100 : 0
    maximumDrawdown = Math.max(maximumDrawdown, drawdown)
    maximumDrawdownPct = Math.max(maximumDrawdownPct, drawdownPct)
    if (account.margin_level_pct != null) {
      lowestMarginLevel = lowestMarginLevel == null
        ? account.margin_level_pct
        : Math.min(lowestMarginLevel, account.margin_level_pct)
    }
    rawCurve.push({
      time_utc_msc:candle._time,
      ...account,
      drawdown:rounded(drawdown),
      drawdown_pct:rounded(drawdownPct, 4),
      open_positions:positions.length,
      pending_orders:pending.length,
      event,
    })
    return account
  }

  const closePositionAt = (position, price, candle, reason, ambiguous = false) => {
    const closed = closeVirtualPosition(position, price, candle._time, reason, ambiguous, balance, options, instrument)
    balance = closed.balance
    records.push(closed.trade)
    const positionIndex = positions.findIndex(item => item.id === position.id)
    if (positionIndex >= 0) positions.splice(positionIndex, 1)
    return closed.trade
  }

  for (const candle of orderedCandles) {
    if (previousCandle && positions.length) {
      for (const rollover of rolloverEvents(previousCandle._time, candle._time, options.timezone_offset_minutes)) {
        const multiplier = swapMultiplier(instrument, rollover.rollover_from_day)
        for (const position of positions) {
          const charge = swapCharge(position, previousCandle, instrument, options, multiplier)
          if (charge.amount == null) {
            swapUnappliedRolloverCount += 1
            continue
          }
          swapRolloverCount += 1
          if (charge.amount !== 0) {
            balance = rounded(balance + charge.amount)
            position.swap = rounded((position.swap || 0) + charge.amount)
            totalSwap = rounded(totalSwap + charge.amount)
          }
        }
      }
    }
    while (intentIndex < intents.length && intents[intentIndex].decision_time_utc_msc <= candle._time) {
      const intent = intents[intentIndex++]
      const brokerViolation = brokerOrderViolation(intent, candle, instrument, pending, positions)
      if (brokerViolation) {
        brokerConstraintRejectedCount += 1
        records.push({
          status:'rejected',
          reason:'broker_contract_constraint',
          broker_reason:brokerViolation,
          signal_index:intent.signal_index,
          decision_time_utc_msc:intent.decision_time_utc_msc,
          direction:intent.direction,
          entry_method:intent.method,
          volume:intent.volume,
        })
      } else if (pending.length >= options.max_pending_orders) {
        pendingLimitRejectedCount += 1
        records.push({
          status:'rejected',
          reason:'max_pending_orders_reached',
          signal_index:intent.signal_index,
          decision_time_utc_msc:intent.decision_time_utc_msc,
          direction:intent.direction,
          entry_method:intent.method,
          volume:intent.volume,
        })
      } else {
        pending.push(intent)
      }
    }

    for (const position of [...positions]) {
      const exit = detectExit(position, position.entry_price, candle, instrument, options)
      if (exit) closePositionAt(position, exit.price, candle, exit.reason, exit.ambiguous)
    }

    for (const intent of [...pending]) {
      const marketExpired = intent.method === 'market'
        && candle._time > intent.decision_time_utc_msc + options.market_entry_ttl_minutes * 60_000
      const pendingExpired = intent.method !== 'market' && candle._time > intent.expiry_time_utc_msc
      if (marketExpired || pendingExpired || candle._time > intent.horizon_end_utc_msc) {
        pending.splice(pending.indexOf(intent), 1)
        records.push({
          status:'expired',
          reason:marketExpired ? 'market_entry_expired' : 'pending_not_triggered',
          signal_index:intent.signal_index,
          decision_time_utc_msc:intent.decision_time_utc_msc,
          expiry_time_utc_msc:intent.method === 'market'
            ? intent.decision_time_utc_msc + options.market_entry_ttl_minutes * 60_000
            : intent.expiry_time_utc_msc,
          direction:intent.direction,
          entry_method:intent.method,
          volume:intent.volume,
        })
        continue
      }
      const entryPrice = fillEntry(intent, candle, instrument, options, intent.state)
      if (intent.state.stop_limit_deferred_this_bar && !intent.state.stop_limit_deferred_counted) {
        stopLimitDeferredCount += 1
        intent.state.stop_limit_deferred_counted = true
      }
      if (!(entryPrice > 0)) continue
      pending.splice(pending.indexOf(intent), 1)
      if (positions.length >= options.max_concurrent_positions) {
        positionLimitRejectedCount += 1
        records.push({
          status:'rejected',
          reason:'max_concurrent_positions_reached',
          signal_index:intent.signal_index,
          decision_time_utc_msc:intent.decision_time_utc_msc,
          direction:intent.direction,
          entry_method:intent.method,
          volume:intent.volume,
          requested_entry_price:rounded(entryPrice),
        })
        continue
      }
      const margin = requiredMargin(intent.volume, entryPrice, instrument, options)
      const accountBefore = summarizeAccount(balance, positions, candle, instrument)
      const entryCommission = rounded(options.commission_per_lot * intent.volume / 2)
      if (!(margin >= 0) || accountBefore.free_margin - entryCommission + 1e-9 < margin) {
        marginRejectedCount += 1
        records.push({
          status:'rejected',
          reason:'insufficient_free_margin',
          signal_index:intent.signal_index,
          decision_time_utc_msc:intent.decision_time_utc_msc,
          direction:intent.direction,
          entry_method:intent.method,
          volume:intent.volume,
          requested_entry_price:rounded(entryPrice),
          required_margin:margin,
          free_margin:accountBefore.free_margin,
        })
        continue
      }
      balance = rounded(balance - entryCommission)
      const position = {
        id:nextPositionId++,
        signal_index:intent.signal_index,
        direction:intent.direction,
        entry_method:intent.method,
        volume:intent.volume,
        decision_time_utc_msc:intent.decision_time_utc_msc,
        entry_time_utc_msc:candle._time,
        entry_price:rounded(entryPrice),
        stop_loss:intent.stop_loss,
        take_profit:intent.take_profit,
        take_profit_tier:intent.take_profit_tier,
        horizon_end_utc_msc:intent.horizon_end_utc_msc,
        margin,
        entry_commission:entryCommission,
        swap:0,
      }
      positions.push(position)
      maximumConcurrentPositions = Math.max(maximumConcurrentPositions, positions.length)
      const immediateExit = detectExit(position, position.entry_price, candle, instrument, options)
      if (immediateExit) closePositionAt(position, immediateExit.price, candle, immediateExit.reason, immediateExit.ambiguous)
    }

    for (const position of [...positions]) {
      if (candle._time >= position.horizon_end_utc_msc) {
        const price = markPrice(position.direction, candle, instrument)
        if (price > 0) closePositionAt(position, price, candle, 'holding_horizon_end')
      }
    }

    let account = summarizeAccount(balance, positions, candle, instrument)
    let stressedAccount = summarizeAccount(balance, positions, candle, instrument, adverseMarkPrice)
    if (stressedAccount.margin_level_pct != null) {
      lowestMarginLevel = lowestMarginLevel == null
        ? stressedAccount.margin_level_pct
        : Math.min(lowestMarginLevel, stressedAccount.margin_level_pct)
    }
    while (positions.length && stressedAccount.margin_level_pct != null
      && stressedAccount.margin_level_pct <= options.stop_out_level_pct) {
      const worst = [...positions].sort((left, right) => {
        const leftPrice = adverseMarkPrice(left.direction, candle, instrument)
        const rightPrice = adverseMarkPrice(right.direction, candle, instrument)
        return grossProfit(left.direction, left.volume, left.entry_price, leftPrice, instrument)
          - grossProfit(right.direction, right.volume, right.entry_price, rightPrice, instrument)
      })[0]
      const price = adverseMarkPrice(worst.direction, candle, instrument)
      closePositionAt(worst, price, candle, 'margin_stop_out')
      stopOutCount += 1
      account = summarizeAccount(balance, positions, candle, instrument)
      stressedAccount = summarizeAccount(balance, positions, candle, instrument, adverseMarkPrice)
    }
    recordAccount(candle)
    previousCandle = candle
  }

  const lastCandle = orderedCandles.at(-1)
  for (const position of [...positions]) {
    const price = markPrice(position.direction, lastCandle, instrument)
    if (price > 0) closePositionAt(position, price, lastCandle, 'data_end')
  }
  for (const intent of pending.splice(0)) {
    records.push({
      status:'not_evaluated',
      reason:'future_candles_unavailable',
      signal_index:intent.signal_index,
      decision_time_utc_msc:intent.decision_time_utc_msc,
      direction:intent.direction,
      entry_method:intent.method,
      volume:intent.volume,
    })
  }
  if (positions.length === 0) recordAccount(lastCandle, 'simulation_complete')
  for (; intentIndex < intents.length; intentIndex += 1) {
    const intent = intents[intentIndex]
    records.push({
      status:'not_evaluated',
      reason:'future_candles_unavailable',
      signal_index:intent.signal_index,
      decision_time_utc_msc:intent.decision_time_utc_msc,
      direction:intent.direction,
      entry_method:intent.method,
      volume:intent.volume,
    })
  }

  const closed = records.filter(record => record.status === 'closed')
  const wins = closed.filter(trade => trade.net_profit > 0)
  const losses = closed.filter(trade => trade.net_profit < 0)
  const grossProfitTotal = wins.reduce((sum, trade) => sum + trade.net_profit, 0)
  const grossLossTotal = Math.abs(losses.reduce((sum, trade) => sum + trade.net_profit, 0))
  const netProfit = rounded(balance - options.starting_balance)
  const finalAccount = summarizeAccount(balance, [], lastCandle, instrument)
  const totalCommission = rounded(closed.reduce((sum, trade) => sum + Number(trade.commission || 0), 0))
  return {
    status:'success',
    simulation_mode:'event_driven_virtual_account',
    realism_level:'m1_ohlc_margin_account',
    execution_resolution:null,
    options,
    instrument,
    starting_balance:rounded(options.starting_balance),
    ending_balance:rounded(balance),
    ending_equity:finalAccount.equity,
    net_profit:netProfit,
    total_commission:totalCommission,
    total_swap:rounded(totalSwap),
    swap_status:options.apply_swap === false
      ? 'disabled'
      : swapUnappliedRolloverCount > 0
        ? 'partial'
        : swapRolloverCount > 0 ? 'ready' : 'not_applicable',
    swap_rollover_count:swapRolloverCount,
    swap_unapplied_rollover_count:swapUnappliedRolloverCount,
    return_pct:rounded(netProfit / options.starting_balance * 100, 4),
    closed_trade_count:closed.length,
    win_count:wins.length,
    loss_count:losses.length,
    win_rate:closed.length ? rounded(wins.length / closed.length * 100, 2) : 0,
    profit_factor:grossLossTotal > 0 ? rounded(grossProfitTotal / grossLossTotal, 4) : grossProfitTotal > 0 ? null : 0,
    max_drawdown:rounded(maximumDrawdown),
    max_drawdown_pct:rounded(maximumDrawdownPct, 4),
    lowest_margin_level_pct:lowestMarginLevel == null ? null : rounded(lowestMarginLevel, 4),
    maximum_concurrent_positions:maximumConcurrentPositions,
    stop_out_count:stopOutCount,
    margin_rejected_count:marginRejectedCount,
    position_limit_rejected_count:positionLimitRejectedCount,
    pending_limit_rejected_count:pendingLimitRejectedCount,
    broker_constraint_rejected_count:brokerConstraintRejectedCount,
    stop_limit_same_bar_deferred_count:stopLimitDeferredCount,
    rejected_order_count:records.filter(record => record.status === 'rejected').length,
    expired_order_count:records.filter(record => record.status === 'expired').length,
    not_evaluated_count:records.filter(record => record.status === 'not_evaluated').length,
    ambiguous_bar_count:closed.filter(trade => trade.same_bar_ambiguous).length,
    skipped_signal_count:skippedSignals,
    intrabar_margin_mode:'conservative_directional_extremes',
    trades:records,
    equity_curve:compactEquityCurve(rawCurve),
  }
}
