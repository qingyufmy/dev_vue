// ai/strategy.js — 策略上下文 + 执行 + 分析

import { queryOne, queryRun, beijingNow } from '../../db.js'
import { isBridgeAlive, sendToBrowsers } from '../../bridge-ws.js'
import { STRATEGY_TIMEFRAME_COUNTS, attachSignalTiming, parseTimeframeTags, compactRates } from './utils.js'
import { mt5Bridge, calculateMarketData } from './market-data.js'
import { maybeAiSignal } from './llm.js'
import { getAnalyzeApiKey, insertAudit, validateTradeRequest, RiskReject, signalOrderPayload } from './config.js'
import { round2 } from './utils.js'

export async function buildStrategyContext(userId, symbol, account, positions, primaryTimeframe, primaryRates) {
  const timeframes = {}
  for (const [tf, count] of Object.entries(STRATEGY_TIMEFRAME_COUNTS)) {
    let rates
    if (tf === primaryTimeframe.toUpperCase() && primaryRates.length >= count) {
      rates = primaryRates
    } else {
      const resp = await mt5Bridge(userId, 'rates', { symbol, timeframe: tf, count })
      rates = (resp && resp.rates) ? resp.rates : []
    }
    const summary = calculateMarketData(symbol, tf, rates, account, positions)
    const { account: _acct, positions: _pos, symbol: _sym, timeframe: _tf, timestamp: _ts, ...slimSummary } = summary
    timeframes[tf] = { summary: slimSummary, klines: compactRates(rates) }
  }
  return {
    strategy_sequence: '1H trend primary, 4H fallback only if 1H unclear, M15 signal confirmation, M5 precise entry trigger',
    required_timeframes: Object.keys(STRATEGY_TIMEFRAME_COUNTS),
    timeframes,
  }
}

export async function buildStrategyContextFromTags(userId, symbol, account, positions, prompt, fallbackTimeframe, fallbackRates, mode = 'manual') {
  let tags = parseTimeframeTags(prompt, mode)
  if (tags.length === 0) {
    const tf = (fallbackTimeframe || 'M30').toUpperCase()
    const count = STRATEGY_TIMEFRAME_COUNTS[tf] || 100
    tags = [{ tf, count }]
  }
  const timeframes = {}
  for (const { tf, count } of tags) {
    let rates
    if (tf === (fallbackTimeframe || '').toUpperCase() && fallbackRates && fallbackRates.length >= count) {
      rates = fallbackRates
    } else {
      const resp = await mt5Bridge(userId, 'rates', { symbol, timeframe: tf, count })
      rates = (resp && resp.rates) ? resp.rates : []
    }
    if (rates.length === 0) continue
    const summary = calculateMarketData(symbol, tf, rates, account, positions)
    const { account: _acct, positions: _pos, symbol: _sym, timeframe: _tf, timestamp: _ts, ...slimSummary } = summary
    timeframes[tf] = { summary: slimSummary, klines: compactRates(rates) }
  }
  return {
    strategy_sequence: tags.map(t => `${t.tf}(${t.count})`).join(' → '),
    required_timeframes: tags.map(t => t.tf),
    timeframes,
  }
}

export async function executeOrder(userId, config, request, action) {
  let accountResult, positionsResult, quote
  accountResult = await mt5Bridge(userId, 'account', {})
  positionsResult = await mt5Bridge(userId, 'positions', {})
  const positions = positionsResult.positions || []
  const account = accountResult

  if (request.symbol) {
    try {
      quote = await mt5Bridge(userId, 'quote', { symbol: request.symbol })
      request.quote_price = parseFloat(request.order_type === 'buy' ? quote.ask : quote.bid)
      const pointSize = quote.point || (request.quote_price > 1000 ? 0.01 : 0.0001)
      if (request.stop_loss_points && !request.sl) {
        request.sl = request.order_type === 'buy'
          ? round2(request.quote_price - request.stop_loss_points * pointSize)
          : round2(request.quote_price + request.stop_loss_points * pointSize)
      }
      if (request.take_profit_points && !request.tp) {
        request.tp = request.order_type === 'buy'
          ? round2(request.quote_price + request.take_profit_points * pointSize)
          : round2(request.quote_price - request.take_profit_points * pointSize)
      }
    } catch {}
  }

  let result
  try {
    const risk = validateTradeRequest(config, account, positions, request)
    let openResult
    openResult = await mt5Bridge(userId, 'open', request)
    result = { ...openResult, risk }
    if (quote) result.quote = quote
  } catch (err) {
    if (err instanceof RiskReject) {
      result = {
        status: err.reason === 'confirmation_required' ? 'needs_confirmation' : 'rejected',
        message: err.reason,
        details: err.details,
      }
    } else {
      result = { status: 'error', message: err.message }
    }
  }

  await insertAudit(null, userId, action, request.symbol, request, result, result.status)
  return result
}

export async function handleAnalyze(userId, params) {
  const { session_id = 'default', symbol, timeframe = 'M30', kline_count = 100, include_positions = true, prompt_override } = params
  if (!symbol) return { status: 'error', message: 'symbol required' }

  const config = await getAnalyzeApiKey(userId, session_id)
  const prompt = prompt_override || config?.system_prompt || ''
  const { parseTimeframeTags } = await import('./utils.js')
  const tags = parseTimeframeTags(prompt)

  const account = await mt5Bridge(userId, 'account', {})
  const positionsData = include_positions ? await mt5Bridge(userId, 'positions', { symbol }) : { positions: [] }
  const positions = positionsData.positions || []

  const primaryTf = tags.length > 0 ? tags[0].tf : timeframe.toUpperCase()
  const primaryCount = tags.length > 0 ? tags[0].count : kline_count
  const ratesResp = await mt5Bridge(userId, 'rates', { symbol, timeframe: primaryTf, count: primaryCount })
  if (!ratesResp || ratesResp.status === 'error') return { status: 'error', message: 'Failed to get rates' }
  const rates = ratesResp.rates || []
  if (!Array.isArray(rates) || rates.length === 0) return { status: 'error', message: 'No rate data' }

  const market = calculateMarketData(symbol, primaryTf, rates, account, positions)
  market.strategy_context = await buildStrategyContextFromTags(userId, symbol, account, positions, prompt, primaryTf, rates, 'manual')
  const signal = await maybeAiSignal(null, config, market)
  market.inference_source = signal._inference_source || 'unknown'
  delete signal._inference_source

  const createdAt = beijingNow()
  const marketJson = JSON.stringify(market)
  const tokenCount = Math.round(((signal.analysis || '').length + (signal.reasoning || '').length + marketJson.length) / 4)
  const result = await queryRun(`INSERT INTO ai_signals(user_id, session_id, symbol, timeframe, signal_type, confidence, recommended_volume,
    analysis, reasoning, stop_loss_price, take_profit_1_price, take_profit_2_price, take_profit_3_price,
    market_data_json, token_count, ai_model, ttl_seconds, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, session_id, symbol, timeframe, signal.signal_type, signal.confidence, signal.recommended_volume,
      signal.analysis, signal.reasoning, signal.stop_loss_price || null,
      signal.take_profit_1_price || null, signal.take_profit_2_price || null, signal.take_profit_3_price || null,
      marketJson, tokenCount, (config || {}).model_name || 'deepseek-chat', (await import('./utils.js')).signalTtlSeconds(timeframe), createdAt])

  signal.id = result.insertId
  signal.symbol = symbol
  signal.timeframe = timeframe.toUpperCase()
  signal.created_at = createdAt
  signal.market_data = market
  signal.is_executed = false
  attachSignalTiming(signal)

  // Push new signal notification to browser
  sendToBrowsers(userId, {
    type: 'new_signal',
    signal_id: signal.id,
    signal_type: signal.signal_type,
    symbol: signal.symbol,
    timeframe: signal.timeframe,
    confidence: signal.confidence,
    created_at: createdAt
  })

  if (signal.signal_type !== 'hold' && config && config.enable_auto_trade) {
    try {
      const riskCfg = {
        enable_auto_trade: true,
        selected_take_profit: config.selected_take_profit ?? 1,
        max_position_size: config.max_position_size ?? 0.05,
      }
      const orderPayload = signalOrderPayload(signal, riskCfg, market, true)

      // Get account and positions for risk validation
      const accountResult = await mt5Bridge(userId, 'account', {})
      const positionsResult = await mt5Bridge(userId, 'positions', {})
      const account = accountResult
      const positions = positionsResult.positions || []

      // Run risk validation before executing
      try {
        validateTradeRequest(riskCfg, account, positions, orderPayload)
      } catch (e) {
        console.log(`[Analyze] Auto-execute blocked by risk: ${e.message}`)
        await insertAudit(null, userId, 'ai_execute', signal.symbol, { signal_id: signal.id, source: 'analyze_auto', risk_block: e.message }, { status: 'rejected', message: e.message }, 'rejected')
        return { status: 'success', signal, market }
      }

      const execResult = await mt5Bridge(userId, 'open', orderPayload)
      if (execResult && execResult.status === 'success') {
        await queryRun('UPDATE ai_signals SET is_executed = 1, executed_at = ?, trade_ticket = ? WHERE id = ?',
          [beijingNow(), execResult.ticket || null, signal.id])
        signal.is_executed = true
        signal.executed_at = beijingNow()
        signal.trade_ticket = execResult.ticket || null
        signal.auto_executed = true
      }
      await insertAudit(null, userId, 'ai_execute', signal.symbol, { signal_id: signal.id, source: 'analyze_auto' }, execResult, execResult?.status || 'error')
    } catch (e) {
      console.error('[Analyze] Auto-execute failed:', e.message)
    }
  }

  return { status: 'success', signal, market }
}
