import { Router } from 'express'
import { query, queryOne, queryAll, queryRun, logAudit } from '../db.js'
import jwt from 'jsonwebtoken'

import { sendBridgeCommand, isBridgeAlive, getBridgeStatus, getAllBridges } from '../bridge-ws.js'

const router = Router()
const JWT_SECRET = process.env.JWT_SECRET || 'wall-street-skill-secret'

const DEFAULT_PROMPT = 'You are a disciplined trading analyst. Return strict JSON with signal_type, confidence, recommended_volume, analysis, reasoning, stop_loss_price, take_profit_1_price, take_profit_2_price, take_profit_3_price.'

const STRATEGY_TIMEFRAME_COUNTS = { H4: 50, H1: 80, M15: 100, M5: 60 }

const EXECUTION_JSON_CONTRACT = `你必须严格依据系统提示词里的策略框架完成推理，尤其是：
1. 1H 主判趋势，只有 1H 不清晰时才参考 4H 降级备判。
2. 15min 用于信号确认，5min 用于精确入场触发。
3. 逆势信号、模糊结构、条件未满足时必须返回 hold，不得勉强给 buy/sell。
4. 只允许输出一个 JSON 对象，不要 Markdown，不要代码块，不要额外解释。

JSON 字段必须完整：
{
  "signal_type": "buy|sell|hold",
  "confidence": 0.0,
  "recommended_volume": 0.0,
  "analysis": "中文，说明按 1H/4H -> 15min -> 5min 的结构判断",
  "reasoning": "中文，说明缠论、谐波、裸K共振或放弃原因",
  "stop_loss_price": null,
  "take_profit_1_price": null,
  "take_profit_2_price": null,
  "take_profit_3_price": null
}

若 signal_type 为 hold，recommended_volume 必须为 0，止损止盈字段必须为 null。
若 signal_type 为 buy/sell，必须给出数字型 recommended_volume、stop_loss_price、take_profit_1_price、take_profit_2_price、take_profit_3_price。`

const TRADE_REVIEW_JSON_CONTRACT = `你现在做订单复盘，不是开仓信号。必须严格依据系统提示词里的策略框架复盘订单是否符合：
1H/4H 趋势过滤、15min 信号确认、5min 入场触发、缠论/谐波/裸K共振、逆势禁止、模糊放弃。

只允许输出一个 JSON 对象，不要 Markdown，不要代码块，不要额外解释。JSON 字段必须完整：
{
  "summary": "中文总结本轮复盘",
  "strategy_compliance": "符合|部分符合|不符合|无订单",
  "orders_reviewed": 0,
  "key_findings": ["中文要点"],
  "mistakes": ["中文问题；没有则空数组"],
  "lessons": ["中文经验"],
  "next_cycle_focus": ["下一轮推理需要重点检查的条件"],
  "order_reviews": [
    {
      "ticket": "订单号",
      "verdict": "符合|部分符合|不符合",
      "reason": "中文原因",
      "improvement": "中文改进"
    }
  ]
}`

async function getSystemPrompt(db) {
  try {
    const row = await queryOne('SELECT prompt FROM system_prompts ORDER BY id LIMIT 1')
    return row?.prompt || DEFAULT_PROMPT
  } catch {
    return DEFAULT_PROMPT
  }
}

// ============ Auth Middleware ============
async function authMiddleware(req, res, next) {
  const auth = req.headers.authorization
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ status: 'error', message: 'Missing bearer token' })
  }
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET)
    req.userId = payload.userId
    req.userEmail = payload.email
    // Load user plan for Pro guard
    const u = await queryOne('SELECT plan, role FROM users WHERE id = ?', [payload.userId])
    req.userPlan = u?.plan || 'free'
    req.userRole = u?.role || 'user'
    next()
  } catch {
    res.status(401).json({ status: 'error', message: 'Invalid or expired token' })
  }
}

function proOnly(req, res, next) {
  if (req.userRole === 'admin' || req.userPlan === 'pro') return next()
  return res.status(403).json({ status: 'error', message: '此功能仅限 Pro 会员使用' })
}

// ============ Helper Functions ============
function utcNow() {
  // Return local Beijing time for MySQL DATETIME (server is UTC+8)
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

const mt5Now = utcNow

function utcToMt5Time(str) {
  // Convert Beijing time (UTC+8) to MT5 broker time (UTC+3): subtract 5 hours
  if (!str) return null
  try {
    const d = new Date(str.replace(' ', 'T'))
    d.setHours(d.getHours() - 5)
    const pad = n => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  } catch {
    return str
  }
}

function signalTtlSeconds(timeframe) {
  const map = { M1: 20, M5: 45, M15: 90, M30: 180, H1: 300, H4: 900, D1: 1800 }
  return map[String(timeframe).toUpperCase()] || 120
}

function signalAgeSeconds(createdAt) {
  try {
    const created = new Date(createdAt.replace(' ', 'T'))
    return Math.max((Date.now() - created.getTime()) / 1000, 0)
  } catch {
    return 999999
  }
}

function attachSignalTiming(signal) {
  const ttl = signalTtlSeconds(signal.timeframe || '')
  const age = signalAgeSeconds(signal.created_at)
  signal.ttl_seconds = ttl
  signal.age_seconds = Math.round(age * 10) / 10
  signal.expires_at = signal.created_at
    ? (() => { const d = new Date(signal.created_at.replace(' ', 'T')); d.setSeconds(d.getSeconds() + ttl); const pad = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` })()
    : null
  signal.is_stale = age > ttl
  signal.created_at_mt5 = utcToMt5Time(signal.created_at)
  signal.expires_at_mt5 = utcToMt5Time(signal.expires_at)
  return signal
}

function configPublic(row) {
  if (!row) return null
  const data = { ...row }
  const hasApiKey = !!data.api_key_encrypted
  data.has_api_key = hasApiKey
  data.masked_api_key = hasApiKey ? '****' : null
  delete data.api_key_encrypted
  delete data.system_prompt
  return data
}

async function getActiveConfig(db, userId, sessionId = 'default', provider = null) {
  let row
  if (provider) {
    row = await queryOne('SELECT * FROM ai_configs WHERE user_id = ? AND session_id = ? AND api_provider = ?', [userId, sessionId, provider])
  } else {
    row = await queryOne('SELECT * FROM ai_configs WHERE user_id = ? AND session_id = ? AND is_active = 1 ORDER BY updated_at DESC LIMIT 1', [userId, sessionId])
  }

  // Model sharing: if user has no custom config, fall back to admin's model settings
  const userHasOwnConfig = row && row.api_key_encrypted
  if (!userHasOwnConfig) {
    const adminConfig = await queryOne('SELECT * FROM ai_configs WHERE model_sharing_enabled = 1 AND is_active = 1 AND user_id IN (SELECT id FROM users WHERE role = \'admin\') LIMIT 1')
    if (adminConfig) {
      if (!row) row = {}
      row.api_provider = row.api_provider || adminConfig.api_provider
      row.model_name = row.model_name || adminConfig.model_name
      row.api_base_url = row.api_base_url || adminConfig.api_base_url
      row.temperature = row.temperature ?? adminConfig.temperature
      row.max_tokens = row.max_tokens ?? adminConfig.max_tokens
      row.model_sharing_enabled = adminConfig.model_sharing_enabled
      if (!row.api_key_encrypted && adminConfig.api_key_encrypted) row.api_key_encrypted = adminConfig.api_key_encrypted
      row._model_shared = true
    }
  }

  // Fallback: if ai_configs has no API key, merge from system_config
  if (!row || !row.api_key_encrypted) {
    const cfg = {}
    try {
      const rows = await queryAll("SELECT `key`, `value` FROM system_config WHERE category = 'ai_provider' AND `value` != ''")
      for (const r of rows) cfg[r.key] = r.value
    } catch {}
    const sysKey = cfg.deepseek_api_key || cfg.openai_api_key
    if (sysKey) {
      if (!row) row = {}
      row.api_key_encrypted = sysKey
      row.api_provider = row.api_provider || (cfg.deepseek_api_key ? 'deepseek' : 'openai')
      row.api_base_url = row.api_base_url || (cfg.deepseek_base_url || cfg.openai_base_url || null)
      row.model_name = row.model_name || (cfg.deepseek_model || cfg.openai_model || 'deepseek-chat')
    }
  }
  return row
}

async function insertAudit(db, userId, action, symbol, request, result, status) {
  await queryRun(`
    INSERT INTO trade_audit_logs(user_id, action, symbol, request_json, result_json, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [userId, action, symbol || null, JSON.stringify(request), JSON.stringify(result), status, utcNow()])
}

// ============ MT5 Bridge (WebSocket via bridge-ws.js) ============
const _bridgeLocks = {} // userId -> Promise chain
async function mt5Bridge(userId, action, params = {}) {
  // Serialize bridge commands per user to prevent concurrent conflicts
  const prev = _bridgeLocks[userId] || Promise.resolve()
  const current = prev.then(async () => {
    let result = await executeViaBridge(userId, action, params)
    // Symbol fallback: XAUUSD -> XAUUSD.s -> XAUUSDm -> XAUUSD.c
    if (result?.status === 'error' && result.message?.includes('Symbol not found') && params.symbol) {
      const variants = [params.symbol + '.s', params.symbol + 'm', params.symbol + '.c', params.symbol + '_']
      for (const v of variants) {
        result = await executeViaBridge(userId, action, { ...params, symbol: v })
        if (result?.status !== 'error') break
      }
    }
    return result
  }).catch(e => ({ status: 'error', message: e.message }))
  _bridgeLocks[userId] = current
  return current
}

// ============ Market Data Calculation ============
function calculateMarketData(symbol, timeframe, rates, account, positions) {
  const closes = rates.map(r => parseFloat(r.close))
  const highs = rates.map(r => parseFloat(r.high))
  const lows = rates.map(r => parseFloat(r.low))
  const latest = closes[closes.length - 1]
  const first = closes[0]
  const smaWindow = closes.length >= 20 ? closes.slice(-20) : closes
  const sma20 = smaWindow.reduce((a, b) => a + b, 0) / smaWindow.length
  const ranges = highs.map((h, i) => h - lows[i])
  const avgVolatility = ranges.reduce((a, b) => a + b, 0) / ranges.length
  const recentHigh = highs.length >= 20 ? Math.max(...highs.slice(-20)) : Math.max(...highs)
  const recentLow = lows.length >= 20 ? Math.min(...lows.slice(-20)) : Math.min(...lows)
  const recentRange = Math.max(recentHigh - recentLow, 0.00001)
  const rangePosition = (latest - recentLow) / recentRange
  const momentum3 = closes.length >= 4 ? ((latest - closes[closes.length - 4]) / closes[closes.length - 4]) * 100 : 0
  const momentum10 = closes.length >= 11 ? ((latest - closes[closes.length - 11]) / closes[closes.length - 11]) * 100 : 0
  const momentum20 = closes.length >= 21 ? ((latest - closes[closes.length - 21]) / closes[closes.length - 21]) * 100 : 0
  const smaDistancePct = latest ? ((latest - sma20) / latest) * 100 : 0
  const volatilityPct = latest ? (avgVolatility / latest) * 100 : 0
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
  const trendStrength = clamp(Math.abs(smaDistancePct) / Math.max(volatilityPct * 0.8, 0.0001), 0, 1)
  let momentumAlignment = 0
  if (momentum3 > 0 && momentum10 > 0) momentumAlignment = 1
  else if (momentum3 < 0 && momentum10 < 0) momentumAlignment = -1
  const edgeScore = clamp(0.35 + trendStrength * 0.35 + Math.min(Math.abs(momentum10) / Math.max(volatilityPct * 4, 0.0001), 0.25), 0.2, 0.9)
  const noisePenalty = clamp(volatilityPct / 0.45, 0, 0.18)
  const dataConfidence = clamp(Math.round((edgeScore - noisePenalty) * 100) / 100, 0.05, 0.95)
  const longPositions = positions.filter(p => p.type === 'buy')
  const shortPositions = positions.filter(p => p.type === 'sell')
  const totalProfit = positions.reduce((sum, p) => sum + parseFloat(p.profit || 0), 0)

  return {
    symbol, timeframe,
    timestamp: mt5Now(),
    latest_price: round5(latest),
    price_change: round5(latest - first),
    price_change_pct: first ? round3(((latest - first) / first) * 100) : 0,
    sma_20: round5(sma20),
    avg_volatility: round5(avgVolatility),
    recent_high_20: round5(recentHigh),
    recent_low_20: round5(recentLow),
    range_position_20: round3(rangePosition),
    sma_distance_pct: round3(smaDistancePct),
    momentum_3_pct: round3(momentum3),
    momentum_10_pct: round3(momentum10),
    momentum_20_pct: round3(momentum20),
    volatility_pct: round3(volatilityPct),
    strategy_score: {
      trend_strength: round3(trendStrength),
      momentum_alignment: momentumAlignment,
      data_confidence: dataConfidence,
      noise_penalty: round3(noisePenalty),
    },
    kline_count: rates.length,
    positions: {
      total_positions: positions.length,
      long_positions: longPositions.length,
      short_positions: shortPositions.length,
      total_profit: round2(totalProfit),
    },
    account: { balance: account.balance, equity: account.equity },
  }
}

function round2(v) { return Math.round(v * 100) / 100 }
function round3(v) { return Math.round(v * 1000) / 1000 }
function round5(v) { return Math.round(v * 100000) / 100000 }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

function compactRates(rates) {
  return rates.map(r => ({
    time: r.time,
    open: round5(parseFloat(r.open || 0)),
    high: round5(parseFloat(r.high || 0)),
    low: round5(parseFloat(r.low || 0)),
    close: round5(parseFloat(r.close || 0)),
    tick_volume: parseInt(r.tick_volume || 0),
  }))
}

function aiFailureHold(market, reason) {
  return {
    signal_type: 'hold',
    confidence: 0.5,
    recommended_volume: 0.0,
    analysis: `${market.symbol} ${market.timeframe}: AI 推理返回未能形成可执行 JSON，系统按保护规则观望。`,
    reasoning: `DeepSeek 推理失败或输出格式不符合执行合约：${reason}。为确保交易严格按策略提示词执行，本轮不使用本地规则替代开仓。`,
    stop_loss_price: null,
    take_profit_1_price: null,
    take_profit_2_price: null,
    take_profit_3_price: null,
    _inference_source: 'ai_error_hold',
  }
}

function parseJsonObject(content) {
  const start = content.indexOf('{')
  const end = content.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) throw new Error('ai_response_missing_json_object')
  return JSON.parse(content.substring(start, end + 1))
}

async function requestJsonObject({ url, apiKey, model, temperature, maxTokens, messages }) {
  const body = { model, temperature, max_tokens: maxTokens, messages }
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  })
  if (!response.ok) throw new Error(`LLM HTTP ${response.status}`)
  const data = await response.json()
  const content = data.choices[0].message.content
  try {
    return parseJsonObject(content)
  } catch (exc) {
    // JSON repair: send back to LLM
    const repairMessages = [
      ...messages,
      { role: 'assistant', content: content.substring(0, 6000) },
      { role: 'user', content: `上一次输出不是合法 JSON，解析错误为：${exc.message}。请只返回修正后的一个 JSON 对象，不要 Markdown，不要解释。` },
    ]
    const repairBody = { model, temperature: 0, max_tokens: maxTokens, messages: repairMessages }
    const repairResp = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(repairBody),
      signal: AbortSignal.timeout(45000),
    })
    if (!repairResp.ok) throw new Error(`LLM repair HTTP ${repairResp.status}`)
    const repairedData = await repairResp.json()
    const repaired = repairedData.choices[0].message.content
    return parseJsonObject(repaired)
  }
}

async function buildStrategyContext(userId, symbol, account, positions, primaryTimeframe, primaryRates) {
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
    timeframes[tf] = { summary, klines: compactRates(rates) }
  }
  return {
    strategy_sequence: '1H trend primary, 4H fallback only if 1H unclear, M15 signal confirmation, M5 precise entry trigger',
    required_timeframes: Object.keys(STRATEGY_TIMEFRAME_COUNTS),
    timeframes,
  }
}

function parseIsoTime(value) {
  if (!value) return null
  try {
    const d = new Date(String(value).replace('Z', '+00:00').replace(' ', 'T'))
    return isNaN(d.getTime()) ? null : d
  } catch { return null }
}

function closedOrderInWindow(order, windowStartMt5, windowEndMt5) {
  const closedAt = parseIsoTime(order.close_time || order.time)
  const start = parseIsoTime(windowStartMt5)
  const end = parseIsoTime(windowEndMt5)
  if (!closedAt || !start || !end) return false
  return start <= closedAt && closedAt <= end
}

function compactSignalForReview(signal) {
  const market = JSON.parse(signal.market_data_json || '{}')
  const execution = signal.execution_result ? JSON.parse(signal.execution_result) : null
  return {
    id: signal.id,
    symbol: signal.symbol,
    timeframe: signal.timeframe,
    signal_type: signal.signal_type,
    confidence: signal.confidence,
    recommended_volume: signal.recommended_volume,
    analysis: signal.analysis,
    reasoning: signal.reasoning,
    stop_loss_price: signal.stop_loss_price,
    take_profit_1_price: signal.take_profit_1_price,
    take_profit_2_price: signal.take_profit_2_price,
    take_profit_3_price: signal.take_profit_3_price,
    created_at: signal.created_at,
    created_at_mt5: utcToMt5Time(signal.created_at),
    inference_source: market.inference_source,
    market_data: market,
    execution_result: execution,
  }
}

async function buildTradeReviewContext(userId, symbol, windowStart, windowEnd) {
  const windowStartMt5 = utcToMt5Time(windowStart)
  const windowEndMt5 = utcToMt5Time(windowEnd)
  const history = await mt5Bridge(userId, 'history', { page: 1, page_size: 100 })
  const recentClosed = (history.orders || []).filter(o => closedOrderInWindow(o, windowStartMt5, windowEndMt5))
  const positionsData = await mt5Bridge(userId, 'positions', { symbol })
  const positions = positionsData.positions || []
  const account = await mt5Bridge(userId, 'account', {})
  const executedSignals = await queryAll(
    `SELECT * FROM ai_signals WHERE user_id = ? AND is_executed = 1 AND created_at >= ? AND created_at <= ? ORDER BY id DESC`,
    [userId, windowStart, windowEnd]
  )
  return {
    symbol,
    window_start_utc: windowStart,
    window_end_utc: windowEnd,
    window_start_mt5: windowStartMt5,
    window_end_mt5: windowEndMt5,
    account,
    open_positions: positions,
    closed_orders: recentClosed,
    executed_signals: (executedSignals || []).map(compactSignalForReview),
    history_statistics: history.statistics,
    review_rule: 'Review only. Do not open, close, or modify orders. Execution remains controlled by LLM signal plus risk checks.',
  }
}

async function reviewTrades(config, reviewContext) {
  if (!config || !config.api_key_encrypted) return { status: 'skipped', reason: 'no_ai_key_for_trade_review', summary: '未配置 AI Key，跳过订单复盘。' }
  const apiKey = config.api_key_encrypted
  if (!apiKey) return { status: 'skipped', reason: 'empty_ai_key_for_trade_review', summary: 'AI Key 为空，跳过订单复盘。' }

  const provider = config.api_provider || 'deepseek'
  const baseUrl = config.api_base_url
  let url
  if (provider === 'deepseek') url = (baseUrl || 'https://api.deepseek.com') + '/chat/completions'
  else if (provider === 'gpt') url = (baseUrl || 'https://api.openai.com') + '/v1/chat/completions'
  else return { status: 'skipped', reason: 'unsupported_ai_provider_for_trade_review' }

  const prompt = await getSystemPrompt(null)
  try {
    const parsed = await requestJsonObject({
      url, apiKey,
      model: config.model_name || 'deepseek-chat',
      temperature: parseFloat(config.temperature || 0.7),
      maxTokens: parseInt(config.max_tokens || 2000),
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: TRADE_REVIEW_JSON_CONTRACT + '\n\n订单复盘上下文 JSON：\n' + JSON.stringify(reviewContext) },
      ],
    })
    parsed.status = 'success'
    return parsed
  } catch (exc) {
    return { status: 'error', reason: 'trade_review_ai_failed', message: exc.message, summary: '订单复盘 AI 调用或 JSON 解析失败。' }
  }
}

// ============ Trade Review Scheduler ============
const tradeReviewState = {} // userId -> { running, timer, lastRunAt }

async function runTradeReviewCycle(userId, trigger) {
  const state = tradeReviewState[userId]
  if (state?.running) return { status: 'skipped', reason: 'previous_trade_review_running' }

  if (!tradeReviewState[userId]) tradeReviewState[userId] = {}
  tradeReviewState[userId].running = true
  tradeReviewState[userId].lastStartedAt = utcNow()

  try {
    const config = await getActiveConfig(null, userId)
    const symbol = 'XAUUSD.s'
    const reviewInterval = 14400
    const now = new Date()
    const windowStart = new Date(now.getTime() - reviewInterval * 1000).toISOString().replace('T', ' ').substring(0, 19)
    const windowEnd = utcNow()

    const context = await buildTradeReviewContext(userId, symbol, windowStart, windowEnd)
    const review = await reviewTrades(config, context)

    const result = {
      ...review,
      trigger,
      window_start_utc: windowStart,
      window_end_utc: windowEnd,
      window_start_mt5: context.window_start_mt5,
      window_end_mt5: context.window_end_mt5,
      closed_orders_count: (context.closed_orders || []).length,
      open_positions_count: (context.open_positions || []).length,
      executed_signals_count: (context.executed_signals || []).length,
    }
    const status = result.status || 'success'
    await insertAudit(null, userId, 'ai_trade_review', symbol, { trigger, window_start: windowStart, window_end: windowEnd }, result, status)

    tradeReviewState[userId].running = false
    tradeReviewState[userId].lastFinishedAt = utcNow()
    tradeReviewState[userId].lastResult = result
    return { status, summary: result.summary, closed_orders_count: result.closed_orders_count, executed_signals_count: result.executed_signals_count }
  } catch (exc) {
    tradeReviewState[userId].running = false
    tradeReviewState[userId].lastError = exc.message
    return { status: 'error', message: exc.message }
  }
}

function startTradeReviewScheduler(userId) {
  if (tradeReviewState[userId]?.timer) return
  const intervalMs = 14400 * 1000 // 4 hours
  tradeReviewState[userId] = { running: false, timer: null, lastRunAt: null }

  const tick = async () => {
    if (!tradeReviewState[userId]) return
    try { await runTradeReviewCycle(userId, 'timer') } catch (e) { console.error(`[TradeReview] ${userId} error:`, e.message) }
    if (tradeReviewState[userId]) {
      tradeReviewState[userId].timer = setTimeout(tick, intervalMs)
    }
  }
  tradeReviewState[userId].timer = setTimeout(tick, 30000) // first run after 30s
  console.log(`[TradeReview] Started for user ${userId} (interval=14400s)`)
}

function stopTradeReviewScheduler(userId) {
  if (tradeReviewState[userId]?.timer) clearTimeout(tradeReviewState[userId].timer)
  tradeReviewState[userId] = null
  console.log(`[TradeReview] Stopped for user ${userId}`)
}

// ============ Rule-Based Signal ============
function ruleBasedSignal(config, market) {
  const latest = parseFloat(market.latest_price)
  const sma = parseFloat(market.sma_20)
  const vol = Math.max(parseFloat(market.avg_volatility), latest * 0.001)
  const score = market.strategy_score || {}
  const dataConfidence = parseFloat(score.data_confidence || 0.55)
  const trendStrength = parseFloat(score.trend_strength || 0)
  const momentumAlignment = parseInt(score.momentum_alignment || 0)
  const momentum10 = parseFloat(market.momentum_10_pct || 0)
  const riskLevel = (config || {}).risk_level || 'medium'
  const maxPosition = parseFloat((config || {}).max_position_size || 0.05)
  const baseVolume = { low: 0.01, medium: 0.02, high: 0.03 }[riskLevel] || 0.02
  const volume = Math.min(baseVolume, maxPosition)

  let signalType, confidence, sl, tp1, tp2, tp3, trendText
  if (latest > sma * 1.0004 && momentumAlignment >= 0) {
    signalType = 'buy'
    confidence = clamp(0.48 + trendStrength * 0.28 + Math.max(momentum10, 0) * 0.7, 0.05, 0.95)
    sl = latest - vol * 1.5
    tp1 = latest + vol * 1.2
    tp2 = latest + vol * 2.0
    tp3 = latest + vol * 3.0
    trendText = 'price is above SMA20 and short-term momentum is positive'
  } else if (latest < sma * 0.9996 && momentumAlignment <= 0) {
    signalType = 'sell'
    confidence = clamp(0.48 + trendStrength * 0.28 + Math.max(-momentum10, 0) * 0.7, 0.05, 0.95)
    sl = latest + vol * 1.5
    tp1 = latest - vol * 1.2
    tp2 = latest - vol * 2.0
    tp3 = latest - vol * 3.0
    trendText = 'price is below SMA20 and short-term momentum is negative'
  } else {
    signalType = 'hold'
    confidence = clamp(0.50 + (1 - trendStrength) * 0.18 + Math.min(Math.abs(market.sma_distance_pct || 0), 0.2) * 0.4, 0.05, 0.95)
    sl = tp1 = tp2 = tp3 = null
    trendText = 'price is close to SMA20 and directional edge is weak'
  }

  return {
    signal_type: signalType,
    confidence: round2(confidence),
    recommended_volume: round2(Math.min(signalType === 'hold' ? 0.01 : volume, maxPosition)),
    analysis: `${market.symbol} ${market.timeframe}: ${trendText}. Latest=${latest}, SMA20=${sma}, avg volatility=${market.avg_volatility}.`,
    reasoning: 'Local rule-based analysis is used because no usable AI key is configured yet.',
    stop_loss_price: sl ? round2(sl) : null,
    take_profit_1_price: tp1 ? round2(tp1) : null,
    take_profit_2_price: tp2 ? round2(tp2) : null,
    take_profit_3_price: tp3 ? round2(tp3) : null,
  }
}

// ============ AI Signal (DeepSeek/GPT) ============
async function maybeAiSignal(db, config, market) {
  if (!config || !config.api_key_encrypted) return aiFailureHold(market, 'missing_ai_configuration_or_key')
  const apiKey = config.api_key_encrypted
  const provider = config.api_provider || 'deepseek'
  const baseUrl = config.api_base_url
  if (!apiKey) return aiFailureHold(market, 'empty_ai_key')

  let url
  if (provider === 'deepseek') url = (baseUrl || 'https://api.deepseek.com') + '/chat/completions'
  else if (provider === 'gpt') url = (baseUrl || 'https://api.openai.com') + '/v1/chat/completions'
  else return aiFailureHold(market, `unsupported_ai_provider:${provider}`)

  try {
    const prompt = await getSystemPrompt(db)
    const parsed = await requestJsonObject({
      url, apiKey,
      model: config.model_name || 'deepseek-chat',
      temperature: parseFloat(config.temperature || 0.7),
      maxTokens: parseInt(config.max_tokens || 2000),
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: EXECUTION_JSON_CONTRACT + '\n\n市场数据 JSON：\n' + JSON.stringify(market) },
      ],
    })
    const required = ['signal_type', 'confidence', 'recommended_volume', 'analysis', 'reasoning']
    if (!required.every(k => k in parsed)) {
      const missing = required.filter(k => !(k in parsed))
      throw new Error(`ai_response_missing_required_fields:${missing.join(',')}`)
    }
    parsed._inference_source = 'ai'
    return normalizeAiSignal(parsed, config, market)
  } catch (exc) {
    return aiFailureHold(market, exc.message)
  }
}

function normalizeAiSignal(parsed, config, market) {
  let signalType = String(parsed.signal_type || 'hold').toLowerCase()
  if (!['buy', 'sell', 'hold'].includes(signalType)) signalType = 'hold'

  const maxPosition = parseFloat((config || {}).max_position_size || 0.05)
  const rawVolume = parseFloat(parsed.recommended_volume || 0)
  const recommendedVolume = signalType === 'hold' ? 0 : round2(Math.max(0.01, Math.min(rawVolume, maxPosition)))

  let rawConfidence = parseFloat(parsed.confidence || 0)
  if (rawConfidence > 1) rawConfidence /= 100

  const score = market.strategy_score || {}
  const dataConfidence = parseFloat(score.data_confidence || 0.55)
  const trendStrength = parseFloat(score.trend_strength || 0)
  const volatilityPct = parseFloat(market.volatility_pct || 0)

  let calibrated
  if (signalType === 'hold') {
    const holdCertainty = 0.50 + (1 - trendStrength) * 0.22 + Math.min(volatilityPct / 0.5, 0.12)
    calibrated = rawConfidence * 0.55 + holdCertainty * 0.45
  } else {
    calibrated = rawConfidence * 0.6 + dataConfidence * 0.4
  }

  parsed.signal_type = signalType
  parsed.confidence = round2(Math.max(0.05, Math.min(0.95, calibrated)))
  parsed.recommended_volume = recommendedVolume
  return parsed
}

// ============ Risk Validation ============
class RiskReject extends Error {
  constructor(reason, details = {}) {
    super(reason)
    this.reason = reason
    this.details = details
  }
}

function validateTradeRequest(config, account, positions, request) {
  const symbol = String(request.symbol || '').toUpperCase()
  const orderType = String(request.order_type || '').toLowerCase()
  const volume = parseFloat(request.volume || 0)
  const maxPosition = parseFloat((config || {}).max_position_size || 0.05)

  if (!symbol) throw new RiskReject('missing_symbol')
  if (request.source === 'ai' && String(request.signal_type || '').toLowerCase() === 'hold') {
    throw new RiskReject('hold_signal_cannot_execute')
  }
  if (!['buy', 'sell'].includes(orderType)) throw new RiskReject('invalid_order_type', { order_type: orderType })
  if (volume <= 0) throw new RiskReject('invalid_volume', { volume })
  if (volume > maxPosition) throw new RiskReject('volume_exceeds_config_limit', { volume, max_position_size: maxPosition })

  const referencePrice = request.reference_price
  const quotePrice = request.quote_price
  if (request.source === 'ai' && referencePrice && quotePrice) {
    const reference = parseFloat(referencePrice)
    const current = parseFloat(quotePrice)
    if (reference > 0) {
      const slippagePct = Math.abs(current - reference) / reference * 100
      if (slippagePct > 0.08) {
        throw new RiskReject('signal_price_slippage_exceeded', {
          reference_price: reference, quote_price: current,
          slippage_pct: round3(slippagePct), limit_pct: 0.08,
        })
      }
    }
  }

  if (request.confirm !== true) throw new RiskReject('confirmation_required')

  const equity = parseFloat(account.equity || 0)
  if (equity <= 0) throw new RiskReject('invalid_account_equity', { equity: account.equity })

  return { symbol, order_type: orderType, volume, max_position_size: maxPosition, account_equity: equity }
}

// ============ Signal Order Payload ============
function signalOrderPayload(signal, config, market, confirm) {
  const tpKey = `take_profit_${(config || {}).selected_take_profit || 1}_price`
  return {
    symbol: signal.symbol,
    order_type: signal.signal_type,
    volume: parseFloat(signal.recommended_volume),
    sl: signal.stop_loss_price,
    tp: signal[tpKey],
    confirm: confirm,
    source: 'ai',
    signal_type: signal.signal_type,
    signal_id: signal.id,
    reference_price: market.latest_price,
  }
}

// ============ Execute Order ============
async function executeOrder(userId, config, request, action) {
  // Try WebSocket bridge first, fallback to old bridge
  let accountResult, positionsResult, quote
  accountResult = await mt5Bridge(userId, 'account', {})
  positionsResult = await mt5Bridge(userId, 'positions', {})
  const positions = positionsResult.positions || []
  const account = accountResult

  if (request.symbol) {
    try {
      quote = await mt5Bridge(userId, 'quote', { symbol: request.symbol })
      request.quote_price = parseFloat(request.order_type === 'buy' ? quote.ask : quote.bid)
      // Convert points to prices for manual orders
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

// Execute command via WebSocket bridge
async function executeViaBridge(userId, action, params, timeoutMs = 10000) {
  return sendBridgeCommand(userId, action, params, timeoutMs)
}

// Handle analyze request (called from WebSocket command handler)
async function handleAnalyze(userId, params) {
  const { session_id = 'default', symbol, timeframe = 'M30', kline_count = 100, include_positions = true } = params
  if (!symbol) return { status: 'error', message: 'symbol required' }

  const config = await getActiveConfig(null, userId, session_id)

  const account = await mt5Bridge(userId, 'account', {})
  const positionsData = include_positions ? await mt5Bridge(userId, 'positions', { symbol }) : { positions: [] }
  const positions = positionsData.positions || []
  const ratesResp = await mt5Bridge(userId, 'rates', { symbol, timeframe, count: kline_count })

  if (!ratesResp || ratesResp.status === 'error') return { status: 'error', message: 'Failed to get rates' }
  const rates = ratesResp.rates || []
  if (!Array.isArray(rates) || rates.length === 0) return { status: 'error', message: 'No rate data' }

  const market = calculateMarketData(symbol, timeframe, rates, account, positions)
  market.strategy_context = await buildStrategyContext(userId, symbol, account, positions, timeframe, rates)
  const signal = await maybeAiSignal(null, config, market)
  market.inference_source = signal._inference_source || 'unknown'
  delete signal._inference_source

  const createdAt = utcNow()
  await queryRun(`INSERT INTO ai_signals(user_id, session_id, symbol, timeframe, signal_type, confidence, recommended_volume,
    analysis, reasoning, stop_loss_price, take_profit_1_price, take_profit_2_price, take_profit_3_price,
    market_data_json, ai_model, ttl_seconds, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, session_id, symbol, timeframe, signal.signal_type, signal.confidence, signal.recommended_volume,
      signal.analysis, signal.reasoning, signal.stop_loss_price || null,
      signal.take_profit_1_price || null, signal.take_profit_2_price || null, signal.take_profit_3_price || null,
      JSON.stringify(market), (config || {}).model_name || 'deepseek-chat', signalTtlSeconds(timeframe), createdAt])

  return { status: 'success', signal, market }
}

// Auth/me endpoint for frontend compatibility
router.get('/auth/me', authMiddleware, async (req, res) => {
  const user = await queryOne('SELECT id, email, nickname, role, plan FROM users WHERE id = ?', [req.userId])
  if (!user) return res.status(404).json({ status: 'error', message: 'User not found' })
  res.json({ id: user.id, username: user.email, nickname: user.nickname, role: user.role, plan: user.plan, is_active: 1, source: 'wss' })
})

// ============ Trade Review API Endpoints ============
router.get('/review/status', authMiddleware, async (req, res) => {
  const state = tradeReviewState[req.userId] || {}
  res.json({ status: 'success', review: {
    enabled: !!state.timer,
    running: !!state.running,
    last_started_at: state.lastStartedAt || null,
    last_finished_at: state.lastFinishedAt || null,
    last_error: state.lastError || null,
    last_result: state.lastResult || null,
  }})
})

router.post('/review/run', authMiddleware, async (req, res) => {
  try {
    const result = await runTradeReviewCycle(req.userId, 'manual')
    res.json(result)
  } catch (exc) {
    res.status(500).json({ status: 'error', message: exc.message })
  }
})

// ============ Auto Scheduler ============
const autoSchedulerState = {} // userId -> { running, timer, lastRunAt, manualBusy }

async function getAutoConfig(db, userId) {
  return await queryOne('SELECT * FROM auto_scheduler WHERE user_id = ?', [userId])
}

async function upsertAutoConfig(db, userId, symbols, timeframes, intervalSeconds, enabled) {
  const now = utcNow()
  await queryRun(`
    INSERT INTO auto_scheduler (user_id, symbols, timeframes, interval_seconds, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      symbols = VALUES(symbols), timeframes = VALUES(timeframes),
      interval_seconds = VALUES(interval_seconds), enabled = VALUES(enabled),
      updated_at = VALUES(updated_at)
  `, [userId, JSON.stringify(symbols), JSON.stringify(timeframes), intervalSeconds, enabled ? 1 : 0, now, now])
}

// Map timeframe to its candle period in ms
function timeframeIntervalMs(tf) {
  const map = { 'M1': 60_000, 'M5': 300_000, 'M15': 900_000, 'M30': 1_800_000, 'H1': 3_600_000, 'H4': 14_400_000, 'D1': 86_400_000 }
  return map[String(tf).toUpperCase()] || 900_000
}

// Run one cycle for a specific symbol × timeframe
async function runAutoCycle(userId, symbol, timeframe) {
  const cfg = await getAutoConfig(null, userId)
  if (!cfg || !cfg.enabled) return

  const config = await getActiveConfig(null, userId, 'default')

  try {
    // Get market data from MT5 bridge
    const account = await mt5Bridge(userId, 'account', {})
    const positionsData = await mt5Bridge(userId, 'positions', { symbol })
    const positions = positionsData.positions || []
    const ratesResp = await mt5Bridge(userId, 'rates', { symbol, timeframe, count: 100 })

    if (!ratesResp || ratesResp.status === 'error') return
    const rates = ratesResp.rates || []
    if (!Array.isArray(rates) || rates.length === 0) return

    const market = calculateMarketData(symbol, timeframe, rates, account, positions)
    market.strategy_context = await buildStrategyContext(userId, symbol, account, positions, timeframe, rates)

    const signal = await maybeAiSignal(null, config, market)
    market.inference_source = signal._inference_source || 'unknown'
    delete signal._inference_source

    const createdAt = utcNow()
    const result = await queryRun(`
      INSERT INTO ai_signals(user_id, config_id, session_id, symbol, timeframe, signal_type, confidence,
        recommended_volume, analysis, reasoning, stop_loss_price, take_profit_1_price,
        take_profit_2_price, take_profit_3_price, market_data_json, is_executed, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `, [
      userId, config?.id || null, 'default', symbol, timeframe.toUpperCase(),
      signal.signal_type, signal.confidence, signal.recommended_volume,
      signal.analysis, signal.reasoning, signal.stop_loss_price,
      signal.take_profit_1_price, signal.take_profit_2_price, signal.take_profit_3_price,
      JSON.stringify(market), createdAt
    ])
    signal.id = result.insertId
    signal.symbol = symbol
    signal.timeframe = timeframe.toUpperCase()
    signal.created_at = createdAt
    signal.market_data = market
    signal.is_executed = false
    attachSignalTiming(signal)

    // Auto-execute if enabled: check inference_source + signal validity + bridge/trade state
    if (config && config.enable_auto_trade && market.inference_source === 'ai' && !signal.is_stale && signal.signal_type !== 'hold') {
      // Check bridge alive and trade enabled
      const bridgeAlive = isBridgeAlive(userId)
      if (!bridgeAlive) {
        console.log(`[AutoScheduler] ${symbol}/${timeframe} skipped: bridge not alive`)
      } else {
        // Check no existing position
        const currentPositions = await mt5Bridge(userId, 'positions', { symbol })
        if ((currentPositions.positions || []).length > 0) {
          console.log(`[AutoScheduler] ${symbol}/${timeframe} skipped: open position exists`)
        } else {
          const order = signalOrderPayload(signal, config, market, true)
          const execResult = await executeOrder(userId, config, order, 'ai_auto_execute')
          if (execResult.status === 'success') {
            await queryRun('UPDATE ai_signals SET is_executed = 1, execution_result = ? WHERE id = ?', [JSON.stringify(execResult), signal.id])
          }
        }
      }
    } else if (market.inference_source !== 'ai') {
      console.log(`[AutoScheduler] ${symbol}/${timeframe} skipped: non-AI signal (source=${market.inference_source})`)
    }

    // Audit log
    await insertAudit(null, userId, 'ai_auto_scan', symbol, { trigger: 'timer', symbol, timeframe, signal_id: signal.id }, {
      status: 'success',
      signal_id: signal.id,
      signal_type: signal.signal_type,
      confidence: signal.confidence,
      inference_source: market.inference_source,
      is_executed: signal.is_executed,
    }, 'success')
  } catch (err) {
    console.error(`[AutoScheduler] ${symbol}/${timeframe} error:`, err.message)
    await insertAudit(null, userId, 'ai_auto_scan', symbol, { trigger: 'timer', symbol, timeframe }, { status: 'error', message: err.message }, 'error')
  }

  // Update last_run_at
  await queryRun('UPDATE auto_scheduler SET last_run_at = ? WHERE user_id = ?', [utcNow(), userId])
  if (autoSchedulerState[userId]) autoSchedulerState[userId].lastRunAt = utcNow()
}

async function startAutoScheduler(userId) {
  if (autoSchedulerState[userId]?.timers && Object.keys(autoSchedulerState[userId].timers).length) return
  const cfg = await getAutoConfig(null, userId)
  if (!cfg || !cfg.enabled) return

  const symbols = JSON.parse(cfg.symbols || '[]')
  const timeframes = JSON.parse(cfg.timeframes || '[]')
  autoSchedulerState[userId] = { running: true, lastRunAt: cfg.last_run_at || null, timers: {} }

  let count = 0
  for (const symbol of symbols) {
    for (const tf of timeframes) {
      const intervalMs = timeframeIntervalMs(tf)
      const key = `${symbol}:${tf}`
      const stagger = Math.random() * 5000 // stagger starts to avoid API bursts

      const tick = async () => {
        if (!autoSchedulerState[userId]?.running) return
        if (autoSchedulerState[userId]?.manualBusy) {
          // Manual analysis in progress, skip this tick and reschedule
          if (autoSchedulerState[userId]?.running) {
            autoSchedulerState[userId].timers[key] = setTimeout(tick, intervalMs)
          }
          return
        }
        try { await runAutoCycle(userId, symbol, tf) } catch (e) { console.error(`[AutoScheduler] ${key} tick error:`, e.message) }
        if (autoSchedulerState[userId]?.running) {
          autoSchedulerState[userId].timers[key] = setTimeout(tick, intervalMs)
        }
      }
      autoSchedulerState[userId].timers[key] = setTimeout(tick, 5000 + stagger)
      count++
    }
  }
  console.log(`[AutoScheduler] Started for user ${userId}: ${count} timers (${timeframes.map(t => t + '=' + (timeframeIntervalMs(t)/1000) + 's').join(', ')})`)

  // Also start trade review scheduler
  startTradeReviewScheduler(userId)
}

function stopAutoScheduler(userId) {
  const state = autoSchedulerState[userId]
  if (state?.timers) {
    for (const t of Object.values(state.timers)) clearTimeout(t)
  }
  if (autoSchedulerState[userId]) autoSchedulerState[userId].running = false
  autoSchedulerState[userId] = null
  console.log(`[AutoScheduler] Stopped for user ${userId}`)
  stopTradeReviewScheduler(userId)
}

export async function initAutoSchedulers() {
  try {
    const rows = await queryAll('SELECT user_id FROM auto_scheduler WHERE enabled = 1')
    for (const row of rows) {
      await startAutoScheduler(row.user_id)
    }
    if (rows.length) console.log(`[AutoScheduler] Restored ${rows.length} scheduler(s)`)
  } catch {}
}


export { executeViaBridge, isBridgeAlive, getBridgeStatus, getAllBridges,
  insertAudit, getActiveConfig, configPublic, mt5Bridge,
  getAutoConfig, upsertAutoConfig, runAutoCycle, DEFAULT_PROMPT,
  signalOrderPayload, attachSignalTiming, handleAnalyze,
  timeframeIntervalMs, startAutoScheduler, stopAutoScheduler,
  getSystemPrompt, buildStrategyContext, maybeAiSignal, aiFailureHold,
  reviewTrades, buildTradeReviewContext, runTradeReviewCycle,
  startTradeReviewScheduler, stopTradeReviewScheduler,
  EXECUTION_JSON_CONTRACT, TRADE_REVIEW_JSON_CONTRACT, STRATEGY_TIMEFRAME_COUNTS }
export default router
