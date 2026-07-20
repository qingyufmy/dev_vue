// ai/strategy.js — 策略上下文 + 执行 + 分析

import { queryOne, queryAll, queryRun, beijingNow, withTransaction } from '../../db.js'
import { isTradeEnabled, sendToBrowsers } from '../../bridge-ws.js'
import { STRATEGY_TIMEFRAME_COUNTS, CHAN_HISTORY_COUNT, CHAN_MAX_HISTORY_COUNT, attachSignalTiming, parseTimeframeTags, compactRates, signalTtlSeconds, stripBrokerSuffix } from './utils.js'
import { mt5Bridge, platformRates, calculateMarketData, computeAtr14 } from './market-data.js'
import { maybeAiSignal } from './llm.js'
import { getAnalyzeApiKey, insertAudit, RiskReject, signalOrderPayload, executeOrderCore, DEFAULT_MAX_POSITION_SIZE, parsePromptSymbols } from './config.js'
import { resolveOwnedModelProfileForRuntime } from './model-profiles.js'
import { retrievePersonalMemory, attachMemoryInjectionSignal, recordPairedInferenceRun, buildPersonalMemoryRetrievalContext } from './memory-system.js'
import { retrievePlatformExperience } from './platform-experience.js'
import { buildSharedMarketSnapshot, persistInferenceSnapshotTx } from './inference-snapshots.js'
import { getStrategyById } from './strategy-ownership.js'
import { parseStrategyPolicy } from './strategy-policy.js'
import { attachSignalPresentation, normalizeDecisionFields, SIGNAL_SCHEMA_VERSION } from './signal-presentation.js'
import { saveChanStructureAnchor } from './platform-market-data.js'

const ATR_ANCHOR_PRIORITY = ['H1', 'H4']
const CHAN_HISTORY_HINT_LIMIT = 512
const _chanMaxHistoryHints = new Map()
const TIMEFRAME_MINUTES = { M1: 1, M5: 5, M15: 15, M30: 30, H1: 60, H4: 240, D1: 1440, W1: 10080 }

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

export function buildChanTimeframeAlignment(timeframes, primaryTimeframe, contextStatus = 'complete') {
  const frames = Object.entries(timeframes || {})
    .map(([timeframe, value]) => ({ timeframe, chan: value?.summary?.chan }))
    .filter(item => item.chan?.trend_state && item.chan.trend_state.state !== 'unavailable')
    .sort((a, b) => (TIMEFRAME_MINUTES[b.timeframe] || 0) - (TIMEFRAME_MINUTES[a.timeframe] || 0))
  const reliableFrames = frames.filter(item => item.chan.reliability !== 'low')
  const higher = reliableFrames[0] || frames[0] || null
  const directional = reliableFrames.filter(item => ['up', 'down'].includes(item.chan.trend_state?.direction))
  const directions = new Set(directional.map(item => item.chan.trend_state.direction))
  let agreement = 'insufficient'
  let direction = 'neutral'
  if (directional.length >= 2 && directions.size === 1) {
    direction = directional[0].chan.trend_state.direction
    agreement = direction === 'up' ? 'aligned_up' : 'aligned_down'
  } else if (directions.size > 1) {
    agreement = 'mixed'
  } else if (directional.length === 1) {
    direction = directional[0].chan.trend_state.direction
  }
  const higherDirection = reliableFrames.length > 0 ? higher?.chan?.trend_state?.direction || 'neutral' : 'neutral'
  const candidates = frames.flatMap(frame => (frame.chan.entry_candidates || []).map(candidate => {
    const candidateDirection = candidate.side === 'buy' ? 'up' : 'down'
    return {
      timeframe: frame.timeframe,
      ...candidate,
      alignment_with_higher: higherDirection === 'neutral'
        ? 'unconfirmed'
        : candidateDirection === higherDirection ? 'aligned' : 'conflict',
    }
  }))
  return {
    status: frames.length === 0 ? 'unavailable' : contextStatus === 'partial' ? 'partial' : 'complete',
    primary_timeframe: String(primaryTimeframe || '').toUpperCase() || null,
    higher_timeframe: higher?.timeframe || null,
    higher_timeframe_direction: higherDirection,
    higher_timeframe_phase: reliableFrames.length > 0 ? higher?.chan?.trend_state?.phase || 'unknown' : 'unknown',
    agreement,
    direction,
    conflict: agreement === 'mixed',
    usable_timeframes: reliableFrames.map(item => item.timeframe),
    excluded_low_reliability_timeframes: frames.filter(item => item.chan.reliability === 'low').map(item => item.timeframe),
    frames: frames.map(item => ({
      timeframe: item.timeframe,
      reliability: item.chan.reliability,
      state: item.chan.trend_state.state,
      direction: item.chan.trend_state.direction,
      phase: item.chan.trend_state.phase,
      reversal_bias: item.chan.trend_state.reversal_bias,
    })),
    entry_candidates: candidates,
    execution_policy: 'evidence_only',
  }
}

export const __strategyTest = { clearChanHistoryHints, buildChanTimeframeAlignment }

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
  const visualizationKlines = {}
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
    if (useChan && summary.chan?.structure_anchor?.recommended_time_utc_msc && chanDataQuality?.source_id) {
      await saveChanStructureAnchor(chanDataQuality.source_id, symbol, tf, summary.chan.structure_anchor).catch(error => {
        console.warn(`[Chan] Failed to persist structure anchor for ${symbol} ${tf}: ${error.message}`)
      })
    }
    const { account: _acct, positions: _pos, symbol: _sym, timeframe: _tf, timestamp: _ts, ...slimSummary } = summary
    timeframes[tf] = { summary: slimSummary, klines: compactRates(visibleRates) }
    if (useChan) visualizationKlines[tf] = compactRates(rates)
  }
  const context = {
    strategy_sequence: tags.map(t => `${t.tf}(${t.count})`).join(' → '),
    required_timeframes: tags.map(t => t.tf),
    used_timeframes: Object.keys(timeframes),
    missing_timeframes: missingTimeframes,
    context_status: missingTimeframes.length === 0 ? 'complete' : 'partial',
    ...(useChan ? { chan_timeframe_alignment: buildChanTimeframeAlignment(timeframes, fallbackTimeframe, missingTimeframes.length === 0 ? 'complete' : 'partial') } : {}),
    timeframes,
  }
  // Snapshot-only evidence: keep it out of model payloads, ai_signals JSON and
  // ordinary WebSocket responses. prepareInferenceSnapshot reads it directly.
  if (useChan) Object.defineProperty(context, 'visualization_klines', { value: visualizationKlines, enumerable: false })
  return context
}

export async function executeOrder(userId, config, request, action, options = {}) {
  return executeOrderCore(userId, config, request, action, options)
}

export async function loadPrivatePortfolioContext(userId) {
  const [positionsData, pendingData] = await Promise.all([
    mt5Bridge(userId, 'positions', {}, { noFallback: true }),
    mt5Bridge(userId, 'pending_list', {}, { noFallback: true }),
  ])
  const pendingOrders = pendingData?.orders ?? pendingData?.pending_list
  if (!positionsData || positionsData.status === 'error' || !Array.isArray(positionsData.positions)
    || !pendingData || pendingData.status === 'error' || !Array.isArray(pendingOrders)) {
    throw new Error('private_portfolio_context_unavailable')
  }
  return { positions: positionsData.positions, pendingOrders }
}

export async function handleAnalyze(userId, params) {
  const { session_id = 'default', symbol, strategy_id, auto_execute = false } = params
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
  config._ai_volume_min = 0.01
  config._ai_volume_max = Number(config.max_position_size ?? DEFAULT_MAX_POSITION_SIZE)
  config._ai_volume_step = 0.01
  config.enable_auto_trade = Boolean(auto_execute)
  config._market_only = strategy.scope === 'platform'
  config._include_portfolio_context = strategy.scope === 'private' && Boolean(Number(strategy.include_portfolio_context))
  const prompt = strategy.system_prompt || ''
  const tags = policy.marketDataPlan.timeframes.map(item => ({ tf: item.timeframe, count: item.kline_count }))

  const account = null
  let positions = []
  let pendingOrders = []
  if (config._include_portfolio_context) {
    try {
      const portfolio = await loadPrivatePortfolioContext(userId)
      positions = portfolio.positions
      pendingOrders = portfolio.pendingOrders
    } catch (error) {
      console.error(`[Analyze] Private portfolio context unavailable for user ${userId}:`, error.message)
      return { status: 'error', message: '已开启持仓与挂单上下文，但当前无法从你的 MT5 获取完整数据，请确认桥接已连接后重试' }
    }
  }

  const primaryTf = policy.marketDataPlan.primary_timeframe || tags[0]?.tf || 'M30'
  const primaryTag = tags.find(item => item.tf === primaryTf) || tags[0]
  const primaryCount = primaryTag?.count || 100
  const primaryHistoryCount = resolveChanHistoryCount(userId, symbol, primaryTf, primaryCount, policy.useChanAnalysis)
  const ratesResp = await platformRates(userId, { symbol, timeframe: primaryTf, count: primaryHistoryCount })
  if (!ratesResp || ratesResp.status === 'error') return { status: 'error', message: 'Failed to get rates' }
  const rates = ratesResp.rates || []
  if (!Array.isArray(rates) || rates.length === 0) return { status: 'error', message: 'No rate data' }

  let market = calculateMarketData(symbol, primaryTf, rates.slice(-primaryCount), account, positions, { pending_orders: pendingOrders })
  market.strategy_context = await buildStrategyContextFromTags(userId, symbol, account, positions, prompt, primaryTf, rates, 'manual', policy.marketDataPlan, policy.useChanAnalysis, ratesResp.market_meta)
  market.requested_timeframes = market.strategy_context.required_timeframes
  market.used_timeframes = market.strategy_context.used_timeframes
  market.missing_timeframes = market.strategy_context.missing_timeframes
  if (policy.useChanAnalysis) market.chan = market.strategy_context?.timeframes?.[primaryTf]?.summary?.chan
  await attachAtrAnchor(userId, symbol, market, primaryTf)
  if (!config._include_portfolio_context) {
    market = buildSharedMarketSnapshot(market, {
      standardSymbol: symbol,
      volumeMin: config._ai_volume_min,
      volumeMax: config._ai_volume_max,
      marketSource: ratesResp.market_meta?.source || 'platform_admin_bridge',
    })
  }
  let memory = { promptBlock: '', mode: 'off', logId: null }
  try {
    if (strategy.scope === 'platform') {
      memory = await retrievePlatformExperience({ strategyId: Number(strategy.id), strategyVersion:Number(strategy.version || 1), symbol, timeframe: primaryTf,
        market, allowedEntryMethods:policy.entryMethods })
    } else {
      const retrievalContext = buildPersonalMemoryRetrievalContext(market, primaryTf, policy.entryMethods)
      memory = await retrievePersonalMemory({ userId, strategyId: Number(strategy.id), strategyVersion: Number(strategy.version || 1),
        symbol, timeframe: primaryTf, direction: retrievalContext.direction,
        entryMethod: retrievalContext.entryMethod, marketRegime: retrievalContext.marketRegime,
        mode: params.memory_mode === 'shadow' ? 'shadow' : 'active' })
    }
  } catch (error) {
    console.error('[Analyze] Experience retrieval failed; continuing without it:', error.message)
  }
  if (config) {
    if (strategy.scope === 'platform') config._platformExperienceContext = memory.promptBlock
    else config._memoryContext = memory.promptBlock
    config._experienceSelection = { source:strategy.scope === 'platform' ? 'platform' : 'personal',
      selectedItemIds:memory.promptBlock ? (memory.selectedItemIds || []) : [],
      selectionDetails:memory.promptBlock ? (memory.selectionDetails || []) : [] }
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
  if (signal._inference_source === 'ai_error_hold') {
    return {
      status: 'error',
      error_code: 'ai_inference_failed',
      message: `AI 推理失败：${signal.reasoning || '模型未返回有效结果'}`,
    }
  }
  delete signal._inference_source

  const createdAt = beijingNow()
  const marketJson = JSON.stringify(market)
  const decision = normalizeDecisionFields(signal)
  const decisionJson = JSON.stringify(decision)
  const tokenCount = Math.round(((signal.analysis || '').length + (signal.reasoning || '').length + marketJson.length) / 4)
  if (!renderedEvidence) throw new Error('inference_evidence_missing')
  const persisted = await withTransaction(async run => {
    const [result] = await run(`INSERT INTO ai_signals(user_id, prompt_type_id, source, session_id, symbol, timeframe, signal_type, confidence, recommended_volume,
      analysis, reasoning, stop_loss_price, take_profit_1_price, take_profit_2_price, take_profit_3_price, recommended_take_profit_tier,
      market_data_json, token_count, ai_model, ttl_seconds, created_at,
      entry_method, limit_price, stop_limit_price, pending_valid_until, schema_version, decision_json)
      VALUES (?, ?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, Number(strategy.id), session_id, symbol, primaryTf, signal.signal_type, signal.confidence, signal.recommended_volume,
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
  signal.user_id = userId
  signal.timeframe = primaryTf
  signal.created_at = createdAt
  signal.market_data = market
  signal.is_executed = false
  attachSignalTiming(signal, ratesResp.market_meta?.timezone_offset_minutes)
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
      sendToBrowsers(userId, { type: 'signal_execution_updated', signal_id: signal.id, status: 'rejected' })
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
        sendToBrowsers(userId, {
          type: 'signal_execution_updated', signal_id: signal.id, status: 'success',
          pending_ticket: isPending ? String(ticket) : null, trade_ticket: isPending ? null : ticket,
        })
      } else {
        const executionStatus = execResult?.status === 'rejected'
          ? 'rejected'
          : execResult?.status === 'uncertain' ? 'uncertain' : 'failed'
        sendToBrowsers(userId, { type: 'signal_execution_updated', signal_id: signal.id, status: executionStatus })
      }
      await insertAudit(null, userId, 'ai_execute', signal.symbol, { signal_id: signal.id, source: 'analyze_auto', tp_tier_requested: orderPayload.tp_tier_requested, tp_tier_used: orderPayload.tp_tier_used, normalization_info: orderPayload.normalization_info }, execResult, execResult?.status || 'error')
    } catch (e) {
      console.error('[Analyze] Auto-execute failed:', e.message)
      signal.execution_result = { status: 'error', message: e.message || '自动执行失败' }
      await queryRun('UPDATE ai_signals SET execution_result = ? WHERE id = ?', [JSON.stringify(signal.execution_result), signal.id])
      sendToBrowsers(userId, { type: 'signal_execution_updated', signal_id: signal.id, status: 'failed' })
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

export async function handleAnalyzeCompare(userId, params) {
  const { symbol, model_ids, strategy_id } = params
  if (!symbol) return { status: 'error', message: 'symbol required' }
  if (!strategy_id) return { ok: false, error: 'strategy_id_required' }
  if (!Array.isArray(model_ids) || model_ids.length < 2 || model_ids.length > 5) {
    return { status: 'error', message: 'model_ids must be an array of 2-5 model profile IDs' }
  }

  const uniqueIds = [...new Set(model_ids.map(Number))]
  if (uniqueIds.length < 2 || uniqueIds.length > 5) {
    return { status: 'error', message: 'model_ids must contain 2-5 unique IDs' }
  }

  const strategy = await getStrategyById(Number(strategy_id), userId, 'user', { forExecution: false })
  if (!strategy) return { ok: false, error: 'strategy_not_found' }

  const supportedSymbols = new Set(parsePromptSymbols(strategy.symbols_json).map(item => stripBrokerSuffix(String(item)).toUpperCase()))
  if (!supportedSymbols.has(stripBrokerSuffix(symbol).toUpperCase())) return { ok: false, error: 'symbol_not_supported_by_strategy' }

  const prompt = strategy.system_prompt || ''
  const policy = parseStrategyPolicy(strategy)
  const primaryTf = policy.marketDataPlan?.primary_timeframe || 'M30'
  const tags = (policy.marketDataPlan?.timeframes || []).map(item => ({ tf: item.timeframe, count: item.kline_count }))
  if (tags.length === 0) tags.push({ tf: primaryTf, count: 100 })
  const primaryTag = tags.find(item => item.tf === primaryTf) || tags[0]
  const primaryCount = primaryTag?.count || 100
  const primaryHistoryCount = resolveChanHistoryCount(userId, symbol, primaryTf, primaryCount, policy.useChanAnalysis)

  const ratesResp = await platformRates(userId, { symbol, timeframe: primaryTf, count: primaryHistoryCount })
  if (!ratesResp || ratesResp.status === 'error') return { status: 'error', message: 'Failed to get rates' }
  const rates = ratesResp.rates || []
  if (!Array.isArray(rates) || rates.length === 0) return { status: 'error', message: 'No rate data' }

  let market = calculateMarketData(symbol, primaryTf, rates.slice(-primaryCount), null, [], {})
  market.strategy_context = await buildStrategyContextFromTags(userId, symbol, null, [], prompt, primaryTf, rates, 'manual', policy.marketDataPlan, policy.useChanAnalysis, ratesResp.market_meta)
  market.requested_timeframes = market.strategy_context.required_timeframes
  market.used_timeframes = market.strategy_context.used_timeframes
  market.missing_timeframes = market.strategy_context.missing_timeframes
  await attachAtrAnchor(userId, symbol, market, primaryTf)
  if (!policy.useChanAnalysis && strategy.scope === 'platform') {
    market = buildSharedMarketSnapshot(market, {
      standardSymbol: symbol,
      volumeMin: 0.01,
      volumeMax: 1.0,
      marketSource: ratesResp.market_meta?.source || 'platform_admin_bridge',
    })
  }

  const profileResults = await Promise.allSettled(
    uniqueIds.map(async (modelId) => {
      const resolved = await resolveOwnedModelProfileForRuntime(modelId, userId)
      if (!resolved.model || !resolved.model.api_key_encrypted) {
        throw new Error(resolved.error || 'model_profile_not_found_or_inactive')
      }
      return { modelId, resolved }
    })
  )

  const validModels = []
  const results = []
  for (let i = 0; i < uniqueIds.length; i++) {
    const profileResult = profileResults[i]
    const modelId = uniqueIds[i]
    if (profileResult.status === 'rejected' || !profileResult.value) {
      results.push({ model_id: modelId, status: 'error', error: profileResult.reason?.message || 'model_profile_resolution_failed' })
    } else {
      validModels.push(profileResult.value)
    }
  }

  const inferenceTasks = validModels.map(({ modelId, resolved }) => {
    const config = {
      ...resolved.model,
      system_prompt: prompt,
      _userId: userId,
      _usage: 'manual',
      _model_shared: resolved.credential_source === 'platform_shared',
      _model_profile_id: resolved.model_profile_id,
      _credential_source: resolved.credential_source,
      _allowed_entry_methods: policy.entryMethods,
      _market_data_plan: policy.marketDataPlan,
      _use_chan_analysis: policy.useChanAnalysis,
      _market_only: strategy.scope === 'platform',
      _ai_volume_min: 0.01,
      _ai_volume_max: 1.0,
      _ai_volume_step: 0.01,
    }
    return maybeAiSignal(null, config, market, prompt).then(signal => {
      signal._inference_source = signal._inference_source || 'unknown'
      return { model_id: modelId, status: 'success', signal }
    }).catch(error => {
      return { model_id: modelId, status: 'error', error: error.message || 'inference_failed' }
    })
  })

  const inferenceResults = await Promise.all(inferenceTasks)
  for (const r of inferenceResults) {
    results.push(r)
  }

  return { ok: true, results, market_snapshot: market }
}

export async function handleHistoryCompare(userId, params) {
  const { symbol, timeframe, model_ids, strategy_id, start_time, end_time, step } = params

  const user = await queryOne('SELECT role FROM users WHERE id = ?', [userId])
  if (!user || user.role !== 'admin') return { status: 'error', message: 'admin_only' }
  if (!symbol) return { status: 'error', message: 'symbol required' }
  if (!timeframe) return { status: 'error', message: 'timeframe required' }
  if (!strategy_id) return { status: 'error', message: 'strategy required' }
  if (!start_time || !end_time) return { status: 'error', message: 'start_time and end_time required' }
  if (!Array.isArray(model_ids) || model_ids.length < 2 || model_ids.length > 5) {
    return { status: 'error', message: 'model_ids must be an array of 2-5 model profile IDs' }
  }

  const uniqueIds = [...new Set(model_ids.map(Number))]
  if (uniqueIds.length < 2 || uniqueIds.length > 5) {
    return { status: 'error', message: 'model_ids must contain 2-5 unique IDs' }
  }

  const strategy = await getStrategyById(Number(strategy_id), userId, 'admin', { forExecution: false })
  if (!strategy) return { status: 'error', message: 'strategy_not_found' }

  const supportedSymbols = new Set(parsePromptSymbols(strategy.symbols_json).map(item => stripBrokerSuffix(String(item)).toUpperCase()))
  if (!supportedSymbols.has(stripBrokerSuffix(symbol).toUpperCase())) return { status: 'error', message: 'symbol_not_supported_by_strategy' }

  const klines = await queryAll(
    `SELECT time, open, high, low, close, tick_volume FROM kline_data
     WHERE symbol = ? AND timeframe = ? AND time >= ? AND time <= ?
     ORDER BY time ASC LIMIT 2000`,
    [String(symbol).toUpperCase(), String(timeframe).toUpperCase(), start_time, end_time]
  )
  if (!klines || klines.length === 0) return { status: 'error', message: 'no_kline_data_for_range' }

  const klineInterval = Math.max(1, Math.min(50, Number(step) || 10))

  const policy = parseStrategyPolicy(strategy)
  const prompt = strategy.system_prompt || ''

  const profileResults = await Promise.allSettled(
    uniqueIds.map(async (modelId) => {
      const resolved = await resolveOwnedModelProfileForRuntime(modelId, userId)
      if (!resolved.model || !resolved.model.api_key_encrypted) {
        throw new Error(resolved.error || 'model_profile_not_found_or_inactive')
      }
      return { modelId, resolved }
    })
  )

  const validModels = []
  const modelErrors = []
  for (let i = 0; i < uniqueIds.length; i++) {
    const profileResult = profileResults[i]
    if (profileResult.status === 'rejected' || !profileResult.value) {
      modelErrors.push({ model_id: uniqueIds[i], status: 'error', error: profileResult.reason?.message || 'model_profile_resolution_failed' })
    } else {
      validModels.push(profileResult.value)
    }
  }

  const modelSignals = {}
  for (const { modelId } of validModels) {
    modelSignals[modelId] = []
  }

  const steps = []
  for (let i = 0; i < klines.length; i += klineInterval) {
    steps.push(i)
  }

  for (const stepIdx of steps) {
    const visibleRates = klines.slice(0, stepIdx + 1).map(k => ({
      time: k.time,
      open: String(k.open), high: String(k.high), low: String(k.low), close: String(k.close),
      tick_volume: String(k.tick_volume),
    }))

    const market = calculateMarketData(symbol, String(timeframe).toUpperCase(), visibleRates, null, [], {})

    const inferenceTasks = validModels.map(({ modelId, resolved }) => {
      const config = {
        ...resolved.model,
        system_prompt: prompt,
        _userId: userId,
        _usage: 'manual',
        _model_shared: resolved.credential_source === 'platform_shared',
        _model_profile_id: resolved.model_profile_id,
        _credential_source: resolved.credential_source,
        _allowed_entry_methods: policy.entryMethods,
        _market_data_plan: policy.marketDataPlan,
        _use_chan_analysis: false,
        _market_only: strategy.scope === 'platform',
        _ai_volume_min: 0.01,
        _ai_volume_max: 1.0,
        _ai_volume_step: 0.01,
      }
      return maybeAiSignal(null, config, market, prompt).then(signal => ({
        modelId, signal: { ...signal, _inference_source: signal._inference_source || 'unknown' },
      })).catch(error => ({
        modelId, error: error.message || 'inference_failed',
      }))
    })

    const results = await Promise.all(inferenceTasks)
    for (const result of results) {
      const kline = klines[stepIdx]
      const openPrice = Number(kline.open)
      const closePrice = Number(kline.close)

      if (result.error) {
        modelSignals[result.modelId].push({
          time: kline.time, signal_type: 'error', confidence: 0, pnl: 0, error: result.error,
        })
        continue
      }

      const signal = result.signal
      let pnl = 0
      if (signal.signal_type === 'buy' && closePrice > openPrice) pnl = closePrice - openPrice
      else if (signal.signal_type === 'sell' && openPrice > closePrice) pnl = openPrice - closePrice

      modelSignals[result.modelId].push({
        time: kline.time, signal_type: signal.signal_type, confidence: signal.confidence || 0, pnl,
      })
    }
  }

  const modelResults = []
  for (const { modelId, resolved } of validModels) {
    const signals = modelSignals[modelId]
    const totalPnl = signals.reduce((sum, s) => sum + s.pnl, 0)
    const buyCount = signals.filter(s => s.signal_type === 'buy').length
    const sellCount = signals.filter(s => s.signal_type === 'sell').length
    const holdCount = signals.filter(s => s.signal_type === 'hold').length
    const winCount = signals.filter(s => s.pnl > 0).length
    const lossCount = signals.filter(s => s.pnl < 0).length
    const errorCount = signals.filter(s => s.signal_type === 'error').length

    modelResults.push({
      model_id: modelId,
      model_name: resolved.model.model_name,
      provider: resolved.model.provider || resolved.model.api_provider,
      status: 'success',
      signal_count: signals.length,
      signals,
      simulated_pnl: {
        total: Number(totalPnl.toFixed(10)),
        win_count: winCount,
        loss_count: lossCount,
        win_rate: signals.length > 0 ? Number(((winCount / signals.length) * 100).toFixed(1)) : 0,
        avg_pnl: signals.length > 0 ? Number((totalPnl / signals.length).toFixed(10)) : 0,
        buy_count: buyCount,
        sell_count: sellCount,
        hold_count: holdCount,
        error_count: errorCount,
      },
    })
  }

  return {
    status: 'success',
    results: [...modelResults, ...modelErrors],
    meta: {
      symbol, timeframe, strategy_id: Number(strategy_id),
      kline_count: klines.length, step: klineInterval,
      start_time: klines[0]?.time, end_time: klines[klines.length - 1]?.time,
    },
  }
}
