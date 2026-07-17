// ai/strategy.js — 策略上下文 + 执行 + 分析

import { queryOne, queryRun, beijingNow, withTransaction } from '../../db.js'
import { isTradeEnabled, sendToBrowsers } from '../../bridge-ws.js'
import { STRATEGY_TIMEFRAME_COUNTS, CHAN_HISTORY_COUNT, CHAN_MAX_HISTORY_COUNT, attachSignalTiming, parseTimeframeTags, compactRates, signalTtlSeconds, stripBrokerSuffix } from './utils.js'
import { mt5Bridge, platformRates, calculateMarketData, computeAtr14 } from './market-data.js'
import { maybeAiSignal } from './llm.js'
import { getAnalyzeApiKey, insertAudit, RiskReject, signalOrderPayload, executeOrderCore, DEFAULT_MAX_POSITION_SIZE, parsePromptSymbols } from './config.js'
import { retrievePersonalMemory, attachMemoryInjectionSignal, recordPairedInferenceRun } from './memory-system.js'
import { retrievePlatformExperience } from './platform-experience.js'
import { persistInferenceSnapshotTx } from './inference-snapshots.js'
import { getStrategyById } from './strategy-ownership.js'
import { parseStrategyPolicy } from './strategy-policy.js'
import { attachSignalPresentation, normalizeDecisionFields, SIGNAL_SCHEMA_VERSION } from './signal-presentation.js'

const ATR_ANCHOR_PRIORITY = ['H1', 'H4']
const CHAN_HISTORY_HINT_LIMIT = 512
const _chanMaxHistoryHints = new Map()

function rememberChanMaxHistory(key) {
  _chanMaxHistoryHints.delete(key)
  _chanMaxHistoryHints.set(key, true)
  if (_chanMaxHistoryHints.size > CHAN_HISTORY_HINT_LIMIT) {
    _chanMaxHistoryHints.delete(_chanMaxHistoryHints.keys().next().value)
  }
}

function clearChanHistoryHints() {
  _chanMaxHistoryHints.clear()
}

function chanHistoryHintKey(userId, symbol, timeframe) {
  return `${userId}:${String(symbol).toUpperCase()}:${String(timeframe).toUpperCase()}`
}

export function resolveChanHistoryCount(userId, symbol, timeframe, requestedCount, useChan) {
  if (!useChan) return requestedCount
  const preferred = _chanMaxHistoryHints.has(chanHistoryHintKey(userId, symbol, timeframe))
    ? CHAN_MAX_HISTORY_COUNT
    : CHAN_HISTORY_COUNT
  return Math.max(requestedCount, preferred)
}

export const __strategyTest = { clearChanHistoryHints }

export async function attachAtrAnchor(userId, symbol, market, primaryTimeframe) {
  const timeframes = market.strategy_context?.timeframes || {}
  for (const tf of ATR_ANCHOR_PRIORITY) {
    const atr = Number(timeframes[tf]?.summary?.atr_14_closed)
    if (atr > 0) {
      market.atr_anchor = atr
      market.atr_anchor_tf = tf
      return market
    }
  }

  try {
    const response = await platformRates(userId, { symbol, timeframe: 'H1', count: 50 })
    const rates = response?.rates || []
    const closedRates = rates.length > 1 ? rates.slice(0, -1) : []
    const atr = closedRates.length >= 15 ? computeAtr14(closedRates) : 0
    if (atr > 0) {
      market.atr_anchor = atr
      market.atr_anchor_tf = 'H1'
      return market
    }
  } catch (error) {
    console.warn(`[ATR Anchor] H1 fetch failed for ${symbol}: ${error.message}`)
  }

  market.atr_anchor = 0
  market.atr_anchor_tf = null
  console.warn(`[ATR Anchor] No closed hourly ATR available for ${symbol}`)
  return market
}

export async function buildStrategyContext(userId, symbol, account, positions, primaryTimeframe, primaryRates) {
  const timeframes = {}
  for (const [tf, count] of Object.entries(STRATEGY_TIMEFRAME_COUNTS)) {
    let rates
    if (tf === primaryTimeframe.toUpperCase() && primaryRates.length >= count) {
      rates = primaryRates
    } else {
      const resp = await platformRates(userId, { symbol, timeframe: tf, count })
      rates = (resp && resp.rates) ? resp.rates : []
    }
    const summary = calculateMarketData(symbol, tf, rates, account, positions, { computeChan: false })
    if (summary.error) continue
    const { account: _acct, positions: _pos, symbol: _sym, timeframe: _tf, timestamp: _ts, ...slimSummary } = summary
    timeframes[tf] = { summary: slimSummary, klines: compactRates(rates) }
  }
  return {
    strategy_sequence: '1H trend primary, 4H fallback only if 1H unclear, M15 signal confirmation, M5 precise entry trigger',
    required_timeframes: Object.keys(STRATEGY_TIMEFRAME_COUNTS),
    timeframes,
  }
}

export async function buildStrategyContextFromTags(userId, symbol, account, positions, prompt, fallbackTimeframe, fallbackRates, mode = 'manual', marketDataPlan = null, useChanAnalysis = null, fallbackMarketMeta = null) {
  let tags = Array.isArray(marketDataPlan?.timeframes)
    ? marketDataPlan.timeframes.map(item => ({ tf: String(item.timeframe || '').toUpperCase(), count: Number(item.kline_count) || 100 }))
    : parseTimeframeTags(prompt, mode)
  if (tags.length === 0) {
    const tf = (fallbackTimeframe || 'M30').toUpperCase()
    const count = STRATEGY_TIMEFRAME_COUNTS[tf] || 100
    tags = [{ tf, count }]
  }
  const useChan = useChanAnalysis == null ? /\{\{USE_CHAN\}\}/.test(prompt) : Boolean(useChanAnalysis)
  const timeframes = {}
  const missingTimeframes = []
  for (const { tf, count } of tags) {
    const historyHintKey = chanHistoryHintKey(userId, symbol, tf)
    const historyCount = resolveChanHistoryCount(userId, symbol, tf, count, useChan)
    let rates
    let chanDataQuality = null
    if (tf === (fallbackTimeframe || '').toUpperCase() && fallbackRates && fallbackRates.length >= historyCount) {
      rates = fallbackRates
      chanDataQuality = fallbackMarketMeta
    } else {
      const resp = await platformRates(userId, { symbol, timeframe: tf, count: historyCount })
      rates = (resp && resp.rates) ? resp.rates : []
      chanDataQuality = resp?.market_meta || null
    }
    if (rates.length === 0) { missingTimeframes.push(tf); continue }
    let visibleRates = rates.slice(-count)
    let summary = calculateMarketData(symbol, tf, visibleRates, account, positions, {
      computeChan: useChan,
      chanRates: rates,
      requestedChanHistoryCount: historyCount,
      chanDataQuality,
    })
    const chanNeedsMoreHistory = summary.chan && (summary.chan.segment_count === 0 || summary.chan.center_count === 0)
    if (useChan && historyCount < CHAN_MAX_HISTORY_COUNT && (rates.length < historyCount || chanNeedsMoreHistory)) {
      rememberChanMaxHistory(historyHintKey)
      if (rates.length < CHAN_MAX_HISTORY_COUNT) {
        const retry = await platformRates(userId, { symbol, timeframe: tf, count: CHAN_MAX_HISTORY_COUNT })
        const retryRates = retry?.rates || []
        if (retryRates.length > rates.length) {
          rates = retryRates
          chanDataQuality = retry?.market_meta || chanDataQuality
          visibleRates = rates.slice(-count)
          summary = calculateMarketData(symbol, tf, visibleRates, account, positions, {
            computeChan: true,
            chanRates: rates,
            requestedChanHistoryCount: CHAN_MAX_HISTORY_COUNT,
            chanDataQuality,
          })
        }
      }
    }
    const { account: _acct, positions: _pos, symbol: _sym, timeframe: _tf, timestamp: _ts, ...slimSummary } = summary
    timeframes[tf] = { summary: slimSummary, klines: compactRates(visibleRates) }
  }
  return {
    strategy_sequence: tags.map(t => `${t.tf}(${t.count})`).join(' → '),
    required_timeframes: tags.map(t => t.tf),
    used_timeframes: Object.keys(timeframes),
    missing_timeframes: missingTimeframes,
    context_status: missingTimeframes.length === 0 ? 'complete' : 'partial',
    timeframes,
  }
}

export async function executeOrder(userId, config, request, action, options = {}) {
  return executeOrderCore(userId, config, request, action, options)
}

export async function handleAnalyze(userId, params) {
  const { session_id = 'default', symbol, include_positions = true, strategy_id, auto_execute = false } = params
  if (!symbol) return { status: 'error', message: 'symbol required' }
  if (!strategy_id) return { status: 'error', message: 'strategy required' }

  const user = await queryOne('SELECT role FROM users WHERE id = ?', [userId])
  const strategy = await getStrategyById(Number(strategy_id), userId, user?.role || 'user', { forExecution: true })
  if (!strategy) return { status: 'error', message: 'strategy_not_available' }
  const supportedSymbols = new Set(parsePromptSymbols(strategy.symbols_json).map(item => stripBrokerSuffix(String(item)).toUpperCase()))
  if (!supportedSymbols.has(stripBrokerSuffix(symbol).toUpperCase())) return { status: 'error', message: 'symbol_not_supported_by_strategy' }
  const policy = parseStrategyPolicy(strategy)
  const config = await getAnalyzeApiKey(userId, session_id, Number(strategy.id))
  config._allowed_entry_methods = policy.entryMethods
  config._market_data_plan = policy.marketDataPlan
  config._use_chan_analysis = policy.useChanAnalysis
  config.enable_auto_trade = Boolean(auto_execute)
  const prompt = strategy.system_prompt || ''
  const tags = policy.marketDataPlan.timeframes.map(item => ({ tf: item.timeframe, count: item.kline_count }))

  const account = null
  const positions = []
  const pendingOrders = []

  const primaryTf = policy.marketDataPlan.primary_timeframe || tags[0]?.tf || 'M30'
  const primaryTag = tags.find(item => item.tf === primaryTf) || tags[0]
  const primaryCount = primaryTag?.count || 100
  const primaryHistoryCount = resolveChanHistoryCount(userId, symbol, primaryTf, primaryCount, policy.useChanAnalysis)
  const ratesResp = await platformRates(userId, { symbol, timeframe: primaryTf, count: primaryHistoryCount })
  if (!ratesResp || ratesResp.status === 'error') return { status: 'error', message: 'Failed to get rates' }
  const rates = ratesResp.rates || []
  if (!Array.isArray(rates) || rates.length === 0) return { status: 'error', message: 'No rate data' }

  const market = calculateMarketData(symbol, primaryTf, rates.slice(-primaryCount), account, positions, { pending_orders: pendingOrders })
  market.strategy_context = await buildStrategyContextFromTags(userId, symbol, account, positions, prompt, primaryTf, rates, 'manual', policy.marketDataPlan, policy.useChanAnalysis, ratesResp.market_meta)
  market.requested_timeframes = market.strategy_context.required_timeframes
  market.used_timeframes = market.strategy_context.used_timeframes
  market.missing_timeframes = market.strategy_context.missing_timeframes
  if (policy.useChanAnalysis) market.chan = market.strategy_context?.timeframes?.[primaryTf]?.summary?.chan
  await attachAtrAnchor(userId, symbol, market, primaryTf)
  let memory = { promptBlock: '', mode: 'off', logId: null }
  try {
    if (strategy.scope === 'platform') {
      memory = await retrievePlatformExperience({ strategyId: Number(strategy.id), symbol, timeframe: primaryTf })
    } else {
      memory = await retrievePersonalMemory({ userId, strategyId: Number(strategy.id), symbol, timeframe: primaryTf, mode: params.memory_mode === 'shadow' ? 'shadow' : 'active' })
    }
  } catch (error) {
    console.error('[Analyze] Experience retrieval failed; continuing without it:', error.message)
  }
  if (config) {
    if (strategy.scope === 'platform') config._platformExperienceContext = memory.promptBlock
    else config._memoryContext = memory.promptBlock
    config._memoryMode = strategy.scope === 'platform' ? `platform_${memory.mode || 'off'}` : (memory.mode || 'off')
  }
  let renderedEvidence = null
  if (config) config._onInferencePrepared = evidence => { renderedEvidence = evidence }
  let signal
  try {
    signal = await maybeAiSignal(null, config, market, prompt)
  } finally {
    if (config) delete config._onInferencePrepared
  }
  market.inference_source = signal._inference_source || 'unknown'
  delete signal._inference_source

  const createdAt = beijingNow()
  const marketJson = JSON.stringify(market)
  const decision = normalizeDecisionFields(signal)
  const decisionJson = JSON.stringify(decision)
  const tokenCount = Math.round(((signal.analysis || '').length + (signal.reasoning || '').length + marketJson.length) / 4)
  if (!renderedEvidence) throw new Error('inference_evidence_missing')
  const persisted = await withTransaction(async run => {
    const [result] = await run(`INSERT INTO ai_signals(user_id, session_id, symbol, timeframe, signal_type, confidence, recommended_volume,
      analysis, reasoning, stop_loss_price, take_profit_1_price, take_profit_2_price, take_profit_3_price, recommended_take_profit_tier,
      market_data_json, token_count, ai_model, ttl_seconds, created_at,
      entry_method, limit_price, stop_limit_price, pending_valid_until, schema_version, decision_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, session_id, symbol, primaryTf, signal.signal_type, signal.confidence, signal.recommended_volume,
        signal.analysis, signal.reasoning, signal.stop_loss_price || null,
        signal.take_profit_1_price || null, signal.take_profit_2_price || null, signal.take_profit_3_price || null,
        signal.recommended_take_profit_tier || null,
        marketJson, tokenCount, (config || {}).model_name || 'deepseek-chat', signalTtlSeconds(primaryTf), createdAt,
        signal.entry_method || 'market', signal.limit_price || null, signal.stop_limit_price || null, signal.pending_valid_until || null,
        SIGNAL_SCHEMA_VERSION, decisionJson])
    const snapshotId = await persistInferenceSnapshotTx(run, {
      signalId: result.insertId, strategyId: Number(strategy.id), strategyVersion: Number(strategy.version || 1), strategyScope: strategy.scope, ownerUserId: Number(strategy.owner_user_id || 0),
      standardSymbol: stripBrokerSuffix(symbol).toUpperCase(), marketSource: ratesResp.market_meta?.source || 'platform_admin_bridge',
      systemPrompt: renderedEvidence.systemPrompt, userPrompt: renderedEvidence.userPrompt,
      outputSchemaVersion: renderedEvidence.outputSchemaVersion, marketSnapshot: market,
      modelProfileId: config?._model_profile_id, provider: config?.api_provider,
      modelName: config?.model_name, credentialSource: config?._credential_source,
      memoryMode: strategy.scope === 'platform' ? `platform_${memory.mode || 'off'}` : (memory.mode || 'off'), createdAt,
    })
    return { signalId: result.insertId, snapshotId }
  })

  signal.id = persisted.signalId
  if (strategy.scope === 'private' && memory.logId) {
    try { await attachMemoryInjectionSignal(memory.logId, userId, signal.id, persisted.snapshotId) }
    catch (error) { console.error('[Analyze] Memory injection attribution failed:', error.message) }
  }
  signal.symbol = symbol
  signal.timeframe = primaryTf
  signal.created_at = createdAt
  signal.market_data = market
  signal.is_executed = false
  attachSignalTiming(signal)
  signal = attachSignalPresentation({ ...signal, ...decision, decision_json: decisionJson })

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
    if (!isTradeEnabled(userId)) {
      console.log(`[Analyze] Auto-execute blocked: trade_send_enabled=0`)
      await insertAudit(null, userId, 'ai_execute', signal.symbol, { signal_id: signal.id, source: 'analyze_auto', reason: 'trade_send_disabled' }, { status: 'rejected', message: '交易发送已关闭' }, 'rejected')
      signal.execution_result = { status: 'rejected', message: '交易发送已关闭' }
      await queryRun('UPDATE ai_signals SET execution_result = ? WHERE id = ?', [JSON.stringify(signal.execution_result), signal.id])
    } else {
    try {
      const riskCfg = {
        enable_auto_trade: true,
        take_profit_mode: 'ai_recommended',
        max_position_size: config.max_position_size ?? DEFAULT_MAX_POSITION_SIZE,
      }
      const orderPayload = signalOrderPayload(signal, riskCfg, market, true)

      const execResult = await executeOrder(userId, riskCfg, orderPayload, 'ai_execute', { sourceType: 'manual_ai' })
      signal.execution_result = execResult
      await queryRun('UPDATE ai_signals SET execution_result = ? WHERE id = ?', [JSON.stringify(execResult || {}), signal.id])
      if (execResult && execResult.status === 'success') {
        const isPending = orderPayload.entry_method && orderPayload.entry_method !== 'market' && orderPayload.entry_method !== 'observe'
        const ticket = execResult.order || execResult.ticket || null
        if (isPending) {
          await queryRun('UPDATE ai_signals SET pending_ticket = ?, pending_state = ? WHERE id = ?',
            [String(ticket), 'pending', signal.id])
          signal.pending_ticket = String(ticket)
          signal.pending_state = 'pending'
        } else {
          await queryRun('UPDATE ai_signals SET is_executed = 1, executed_at = ?, trade_ticket = ? WHERE id = ?',
            [beijingNow(), ticket, signal.id])
          signal.is_executed = true
          signal.executed_at = beijingNow()
          signal.trade_ticket = ticket
        }
        signal.auto_executed = true
      }
      await insertAudit(null, userId, 'ai_execute', signal.symbol, { signal_id: signal.id, source: 'analyze_auto', tp_tier_requested: orderPayload.tp_tier_requested, tp_tier_used: orderPayload.tp_tier_used, normalization_info: orderPayload.normalization_info }, execResult, execResult?.status || 'error')
    } catch (e) {
      console.error('[Analyze] Auto-execute failed:', e.message)
      signal.execution_result = { status: 'error', message: e.message || '自动执行失败' }
      await queryRun('UPDATE ai_signals SET execution_result = ? WHERE id = ?', [JSON.stringify(signal.execution_result), signal.id])
    }
    }
  }

  if (strategy.scope === 'private' && memory.pairedExperimentEnabled && memory.mode === 'active' && memory.promptBlock) {
    let control = null
    let pairStatus = 'failed'
    let pairError = null
    try {
      const controlConfig = { ...config, _memoryContext: '', _memoryMode: 'off' }
      delete controlConfig._onInferencePrepared
      control = await maybeAiSignal(null, controlConfig, market, prompt)
      const controlSource = control?._inference_source
      if (control) delete control._inference_source
      pairStatus = controlSource === 'ai' ? 'succeeded' : 'failed'
      pairError = pairStatus === 'failed' ? (control?.reasoning || 'paired_control_failed') : null
    } catch (error) {
      pairError = error.message || 'paired_control_failed'
    }
    try {
      await recordPairedInferenceRun({ userId, strategyId: Number(strategy.id), signalId: signal.id,
        memoryLogId: memory.logId, treatment: signal, control, status: pairStatus, errorCode: pairError })
    } catch (error) {
      console.error('[Analyze] Paired inference evidence write failed:', error.message)
    }
  }

  signal = attachSignalPresentation(signal)
  return { status: 'success', signal, market }
}
