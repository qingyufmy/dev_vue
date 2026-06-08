import { Router } from 'express'
import { getDB } from '../db.js'
import jwt from 'jsonwebtoken'
import http from 'http'

const router = Router()
const JWT_SECRET = process.env.JWT_SECRET || 'wall-street-skill-secret'
const MT5_BRIDGE_HOST = '127.0.0.1'
const MT5_BRIDGE_PORT = 8766

// ============ Auth Middleware ============
function authMiddleware(req, res, next) {
  const auth = req.headers.authorization
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ status: 'error', message: 'Missing bearer token' })
  }
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET)
    req.userId = payload.userId
    req.userEmail = payload.email
    next()
  } catch {
    res.status(401).json({ status: 'error', message: 'Invalid or expired token' })
  }
}

// ============ Helper Functions ============
function utcNow() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19)
}

function mt5Now() {
  const now = new Date()
  now.setHours(now.getHours() + 3) // MT5 server UTC+3
  return now.toISOString().replace('T', ' ').substring(0, 19)
}

function utcToMt5Time(utcStr) {
  if (!utcStr) return null
  const d = new Date(utcStr)
  if (isNaN(d.getTime())) return null
  d.setHours(d.getHours() + 3)
  return d.toISOString().replace('T', ' ').substring(0, 19)
}

function signalTtlSeconds(timeframe) {
  const map = { M1: 20, M5: 45, M15: 90, M30: 180, H1: 300, H4: 900, D1: 1800 }
  return map[String(timeframe).toUpperCase()] || 120
}

function signalAgeSeconds(createdAt) {
  try {
    // created_at is stored as UTC string (from toISOString), append Z to parse as UTC
    const created = new Date(createdAt + 'Z')
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
    ? new Date(new Date(signal.created_at).getTime() + ttl * 1000).toISOString().replace('T', ' ').substring(0, 19)
    : null
  signal.is_stale = age > ttl
  signal.created_at_mt5 = utcToMt5Time(signal.created_at)
  signal.expires_at_mt5 = utcToMt5Time(signal.expires_at)
  return signal
}

function configPublic(row, includePrompt = true) {
  if (!row) return null
  const data = { ...row }
  const hasApiKey = !!data.api_key_encrypted
  data.has_api_key = hasApiKey
  data.masked_api_key = hasApiKey ? '****' : null
  delete data.api_key_encrypted
  if (!includePrompt) delete data.system_prompt
  return data
}

function getActiveConfig(db, userId, sessionId = 'default', provider = null) {
  if (provider) {
    return db.prepare('SELECT * FROM ai_configs WHERE user_id = ? AND session_id = ? AND api_provider = ?').get(userId, sessionId, provider)
  }
  return db.prepare('SELECT * FROM ai_configs WHERE user_id = ? AND session_id = ? AND is_active = 1 ORDER BY updated_at DESC LIMIT 1').get(userId, sessionId)
}

function insertAudit(db, userId, action, symbol, request, result, status) {
  db.prepare(`
    INSERT INTO trade_audit_logs(user_id, action, symbol, request_json, result_json, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, action, symbol || null, JSON.stringify(request), JSON.stringify(result), status, utcNow())
}

// ============ MT5 Bridge Proxy ============
function mt5BridgeRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' }
    let bodyStr = null
    if (body) {
      bodyStr = JSON.stringify(body)
      headers['Content-Length'] = Buffer.byteLength(bodyStr)
    }
    const options = {
      hostname: MT5_BRIDGE_HOST,
      port: MT5_BRIDGE_PORT,
      path: path,
      method: method,
      headers: headers,
      timeout: 30000,
    }
    const req = http.request(options, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          resolve(JSON.parse(data))
        } catch {
          resolve({ status: 'error', message: 'Invalid response from MT5 bridge', raw: data })
        }
      })
    })
    req.on('error', (err) => {
      resolve({ status: 'error', message: 'MT5 bridge unavailable: ' + err.message })
    })
    req.on('timeout', () => {
      req.destroy()
      resolve({ status: 'error', message: 'MT5 bridge timeout' })
    })
    if (bodyStr) req.write(bodyStr)
    req.end()
  })
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
async function maybeAiSignal(config, market) {
  try {
    if (!config || !config.api_key_encrypted) return null
    const apiKey = config.api_key_encrypted // In WSS, we store plain text key
    const provider = config.api_provider || 'deepseek'
    const baseUrl = config.api_base_url
    if (!apiKey) return null

    let url
    if (provider === 'deepseek') url = baseUrl || 'https://api.deepseek.com/chat/completions'
    else if (provider === 'gpt') url = baseUrl || 'https://api.openai.com/v1/chat/completions'
    else return null

    const prompt = config.system_prompt || 'You are a disciplined trading analyst. Return strict JSON with signal_type, confidence, recommended_volume, analysis, reasoning, stop_loss_price, take_profit_1_price, take_profit_2_price, take_profit_3_price.'

    const body = {
      model: config.model_name || 'deepseek-chat',
      temperature: parseFloat(config.temperature || 0.7),
      max_tokens: parseInt(config.max_tokens || 2000),
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: 'Analyze this market snapshot and return strict JSON only:\n' + JSON.stringify(market) },
      ],
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45000),
    })

    if (!response.ok) return null
    const data = await response.json()
    const content = data.choices[0].message.content
    const start = content.indexOf('{')
    const end = content.lastIndexOf('}')
    if (start === -1 || end === -1 || end <= start) return null

    const parsed = JSON.parse(content.substring(start, end + 1))
    const required = ['signal_type', 'confidence', 'recommended_volume', 'analysis', 'reasoning']
    if (!required.every(k => k in parsed)) return null

    return normalizeAiSignal(parsed, config, market)
  } catch {
    return null
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
  const accountResult = await mt5BridgeRequest('GET', '/account')
  const positionsResult = await mt5BridgeRequest('GET', '/positions')
  const positions = positionsResult.positions || []
  const account = accountResult

  let quote = null
  if (request.symbol) {
    try {
      quote = await mt5BridgeRequest('GET', `/quote/${request.symbol}`)
      request.quote_price = parseFloat(request.order_type === 'buy' ? quote.ask : quote.bid)
    } catch {}
  }

  let result
  try {
    const risk = validateTradeRequest(config, account, positions, request)
    const openResult = await mt5BridgeRequest('POST', '/open', request)
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

  const db = getDB()
  insertAudit(db, userId, action, request.symbol, request, result, result.status)
  return result
}

// ============ API Routes ============

// Get AI config
router.get('/ai/config', authMiddleware, (req, res) => {
  const { session_id = 'default', api_provider } = req.query
  const db = getDB()
  const row = getActiveConfig(db, req.userId, session_id, api_provider)
  res.json({ status: 'success', config: configPublic(row) })
})

// Get all AI configs
router.get('/ai/config/all', authMiddleware, (req, res) => {
  const { session_id = 'default' } = req.query
  const db = getDB()
  const rows = db.prepare('SELECT * FROM ai_configs WHERE user_id = ? AND session_id = ?').all(req.userId, session_id)
  const configs = {}
  for (const row of rows) {
    const item = configPublic(row, false)
    configs[item.api_provider] = {
      api_provider: item.api_provider,
      has_config: true,
      is_active: !!item.is_active,
      model_name: item.model_name,
      has_api_key: item.has_api_key,
      masked_api_key: item.masked_api_key,
    }
  }
  res.json({ status: 'success', configs })
})

// Create/update AI config
router.post('/ai/config', authMiddleware, (req, res) => {
  const { session_id = 'default', config: cfg } = req.body
  if (!cfg) return res.status(400).json({ status: 'error', message: 'config required' })
  const db = getDB()
  const now = utcNow()

  db.prepare('UPDATE ai_configs SET is_active = 0 WHERE user_id = ? AND session_id = ?').run(req.userId, session_id)
  db.prepare(`
    INSERT INTO ai_configs(user_id, session_id, api_provider, api_key_encrypted, api_base_url, model_name,
      temperature, max_tokens, enable_auto_trade, enable_futures_trading, risk_level,
      max_position_size, selected_take_profit, system_prompt, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(user_id, session_id, api_provider) DO UPDATE SET
      api_key_encrypted = excluded.api_key_encrypted, api_base_url = excluded.api_base_url,
      model_name = excluded.model_name, temperature = excluded.temperature, max_tokens = excluded.max_tokens,
      enable_auto_trade = excluded.enable_auto_trade, enable_futures_trading = excluded.enable_futures_trading,
      risk_level = excluded.risk_level, max_position_size = excluded.max_position_size,
      selected_take_profit = excluded.selected_take_profit, system_prompt = excluded.system_prompt,
      is_active = 1, updated_at = excluded.updated_at
  `).run(
    req.userId, session_id, cfg.api_provider || 'deepseek', cfg.api_key || null,
    cfg.api_base_url || null, cfg.model_name || 'deepseek-chat',
    cfg.temperature || 0.7, cfg.max_tokens || 2000,
    cfg.enable_auto_trade ? 1 : 0, cfg.enable_futures_trading ? 1 : 0,
    cfg.risk_level || 'medium', cfg.max_position_size || 0.05,
    cfg.selected_take_profit || 1, cfg.system_prompt || null, now, now
  )
  const row = getActiveConfig(db, req.userId, session_id, cfg.api_provider)
  res.json({ status: 'success', config: configPublic(row) })
})

// Update system prompt
router.put('/ai/config/prompt', authMiddleware, (req, res) => {
  const { session_id = 'default', system_prompt } = req.body
  const db = getDB()
  const row = getActiveConfig(db, req.userId, session_id)
  if (!row) return res.status(404).json({ status: 'error', message: 'No active config' })
  db.prepare('UPDATE ai_configs SET system_prompt = ?, updated_at = ? WHERE id = ?').run(system_prompt, utcNow(), row.id)
  res.json({ status: 'success' })
})

// Test AI connection
router.post('/ai/test', authMiddleware, (req, res) => {
  const { api_key } = req.body
  if (!api_key) return res.status(400).json({ status: 'error', message: 'api_key required' })
  res.json({ status: 'success', message: 'Configuration shape is valid.' })
})

// Analyze market
router.post('/ai/analyze', authMiddleware, async (req, res) => {
  try {
    const { session_id = 'default', symbol, timeframe = 'M30', kline_count = 100, include_positions = true } = req.body
    if (!symbol) return res.status(400).json({ status: 'error', message: 'symbol required' })

    const db = getDB()
    const config = getActiveConfig(db, req.userId, session_id)

    // Get market data from MT5 bridge
    const account = await mt5BridgeRequest('GET', '/account')
    const positionsData = include_positions ? await mt5BridgeRequest('GET', `/positions?symbol=${symbol}`) : { positions: [] }
    const positions = positionsData.positions || []
    const rates = await mt5BridgeRequest('GET', `/rates?symbol=${symbol}&timeframe=${timeframe}&count=${kline_count}`)

    if (!rates || rates.status === 'error') {
      return res.status(500).json({ status: 'error', message: rates?.message || 'Failed to get rates' })
    }

    const market = calculateMarketData(symbol, timeframe, rates, account, positions)

    // Try AI signal first, fallback to rule-based
    let signal = await maybeAiSignal(config, market)
    if (!signal) signal = ruleBasedSignal(config, market)

    const createdAt = utcNow()
    const stmt = db.prepare(`
      INSERT INTO ai_signals(user_id, config_id, session_id, symbol, timeframe, signal_type, confidence,
        recommended_volume, analysis, reasoning, stop_loss_price, take_profit_1_price,
        take_profit_2_price, take_profit_3_price, market_data_json, is_executed, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `)
    const result = stmt.run(
      req.userId, config?.id || null, session_id, symbol, timeframe.toUpperCase(),
      signal.signal_type, signal.confidence, signal.recommended_volume,
      signal.analysis, signal.reasoning, signal.stop_loss_price,
      signal.take_profit_1_price, signal.take_profit_2_price, signal.take_profit_3_price,
      JSON.stringify(market), createdAt
    )

    signal.id = result.lastInsertRowid
    signal.symbol = symbol
    signal.timeframe = timeframe.toUpperCase()
    signal.created_at = createdAt
    signal.market_data = market
    signal.is_executed = false
    attachSignalTiming(signal)

    // Auto-execute if enabled
    signal.auto_execution = { status: 'skipped', reason: 'auto_trade_disabled' }
    if (config && config.enable_auto_trade) {
      const autoResult = await maybeAutoExecuteSignal(req.userId, config, signal, market, 'ai_auto_execute')
      signal.auto_execution = autoResult
      if (autoResult.status === 'success') {
        db.prepare('UPDATE ai_signals SET is_executed = 1, execution_result = ? WHERE id = ?').run(JSON.stringify(autoResult), signal.id)
        signal.is_executed = true
        signal.execution_result = autoResult
      }
    }

    res.json({ status: 'success', signal })
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message })
  }
})

async function maybeAutoExecuteSignal(userId, config, signal, market, action) {
  if (signal.is_stale) return { status: 'skipped', reason: 'signal_expired' }
  if (String(signal.signal_type || '').toLowerCase() === 'hold') return { status: 'skipped', reason: 'hold_signal_cannot_execute' }

  const order = signalOrderPayload(signal, config, market, true)
  return await executeOrder(userId, config, order, action)
}

// Get signals
router.get('/ai/signals', authMiddleware, (req, res) => {
  const { session_id = 'default' } = req.query
  const db = getDB()
  const rows = db.prepare('SELECT * FROM ai_signals WHERE user_id = ? AND session_id = ? ORDER BY id DESC LIMIT 100').all(req.userId, session_id)
  const signals = rows.map(row => {
    const item = { ...row }
    try { item.market_data = JSON.parse(item.market_data_json) } catch { item.market_data = {} }
    delete item.market_data_json
    item.is_executed = !!item.is_executed
    attachSignalTiming(item)
    return item
  })
  res.json({ status: 'success', signals })
})

// Get signal detail
router.get('/ai/signals/:signalId', authMiddleware, (req, res) => {
  const db = getDB()
  const row = db.prepare('SELECT * FROM ai_signals WHERE id = ? AND user_id = ?').get(req.params.signalId, req.userId)
  if (!row) return res.status(404).json({ status: 'error', message: 'Signal not found' })
  const item = { ...row }
  try { item.market_data = JSON.parse(item.market_data_json) } catch { item.market_data = {} }
  delete item.market_data_json
  item.is_executed = !!item.is_executed
  attachSignalTiming(item)
  res.json({ status: 'success', signal: item })
})

// Execute signal
router.post('/ai/execute', authMiddleware, async (req, res) => {
  try {
    const { session_id = 'default', signal_id, confirm = false } = req.body
    const db = getDB()
    const signal = db.prepare('SELECT * FROM ai_signals WHERE id = ? AND user_id = ?').get(signal_id, req.userId)
    if (!signal) return res.status(404).json({ status: 'error', message: 'Signal not found' })

    const config = getActiveConfig(db, req.userId, session_id)
    const timedSignal = attachSignalTiming({ ...signal })

    if (timedSignal.is_stale) {
      const result = {
        status: 'rejected', message: 'signal_expired',
        details: { age_seconds: timedSignal.age_seconds, ttl_seconds: timedSignal.ttl_seconds },
      }
      insertAudit(db, req.userId, 'ai_execute', signal.symbol, { signal_id, confirm }, result, result.status)
      return res.json(result)
    }

    const marketData = JSON.parse(signal.market_data_json || '{}')
    const order = signalOrderPayload(signal, config, marketData, confirm)
    const result = await executeOrder(req.userId, config, order, 'ai_execute')

    if (result.status === 'success') {
      db.prepare('UPDATE ai_signals SET is_executed = 1, execution_result = ? WHERE id = ?').run(JSON.stringify(result), signal.id)
    }
    res.json(result)
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message })
  }
})

// MT5 Status
router.get('/mt5/status', authMiddleware, async (req, res) => {
  const result = await mt5BridgeRequest('GET', '/status')
  res.json({ status: 'success', ...result })
})

// MT5 Account
router.get('/mt5/account', authMiddleware, async (req, res) => {
  const result = await mt5BridgeRequest('GET', '/account')
  res.json(result)
})

// MT5 Symbols
router.get('/mt5/symbols', authMiddleware, async (req, res) => {
  const result = await mt5BridgeRequest('GET', '/symbols')
  res.json(result)
})

// MT5 Quote
router.get('/mt5/quote/:symbol', authMiddleware, async (req, res) => {
  const result = await mt5BridgeRequest('GET', `/quote/${req.params.symbol}`)
  res.json(result)
})

// MT5 Positions
router.get('/mt5/positions', authMiddleware, async (req, res) => {
  const { symbol } = req.query
  const path = symbol ? `/positions?symbol=${symbol}` : '/positions'
  const result = await mt5BridgeRequest('GET', path)
  res.json(result)
})

// MT5 History
router.get('/mt5/history', authMiddleware, async (req, res) => {
  const { page = 1, page_size = 20 } = req.query
  const result = await mt5BridgeRequest('GET', `/history?page=${page}&page_size=${page_size}`)
  res.json(result)
})

// MT5 Open Position
router.post('/mt5/open', authMiddleware, async (req, res) => {
  const db = getDB()
  const config = getActiveConfig(db, req.userId, 'default')
  const result = await executeOrder(req.userId, config, req.body, 'manual_open')
  res.json(result)
})

// MT5 Close Position
router.post('/mt5/close', authMiddleware, async (req, res) => {
  const { ticket, confirm = false } = req.body
  let result
  if (!confirm) {
    result = { status: 'needs_confirmation', message: 'confirmation_required' }
  } else {
    result = await mt5BridgeRequest('POST', '/close', { ticket })
  }
  const db = getDB()
  insertAudit(db, req.userId, 'manual_close', null, { ticket, confirm }, result, result.status)
  res.json(result)
})

// MT5 Rates (K-line data)
router.get('/mt5/rates', authMiddleware, async (req, res) => {
  const { symbol, timeframe = 'M30', count = 100 } = req.query
  if (!symbol) return res.status(400).json({ status: 'error', message: 'symbol required' })
  const result = await mt5BridgeRequest('GET', `/rates?symbol=${symbol}&timeframe=${timeframe}&count=${count}`)
  res.json(result)
})

// MT5 Diagnostics
router.get('/mt5/diagnostics', authMiddleware, async (req, res) => {
  const result = await mt5BridgeRequest('GET', '/diagnostics')
  res.json(result)
})

// Audit logs
router.get('/audit/logs', authMiddleware, (req, res) => {
  const db = getDB()
  const rows = db.prepare('SELECT * FROM trade_audit_logs WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(req.userId)
  const logs = rows.map(row => {
    const item = { ...row }
    try { item.request = JSON.parse(item.request_json) } catch { item.request = {} }
    try { item.result = JSON.parse(item.result_json) } catch { item.result = {} }
    delete item.request_json
    delete item.result_json
    item.created_at_mt5 = utcToMt5Time(item.created_at)
    return item
  })
  res.json({ status: 'success', logs })
})

// UI Config (theme)
router.get('/ui/config', authMiddleware, (req, res) => {
  const db = getDB()
  const row = db.prepare('SELECT theme FROM ui_configs WHERE user_id = ?').get(req.userId)
  res.json({ status: 'success', theme: (row || {}).theme || 'theme2' })
})

router.post('/ui/config', authMiddleware, (req, res) => {
  const { theme } = req.body
  if (!theme || !theme.startsWith('theme')) return res.status(400).json({ status: 'error', message: 'Invalid theme' })
  const db = getDB()
  const now = utcNow()
  db.prepare(`
    INSERT INTO ui_configs(user_id, theme, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET theme = excluded.theme, updated_at = excluded.updated_at
  `).run(req.userId, theme, now)
  res.json({ status: 'success', theme })
})

// Health check
router.get('/health', async (req, res) => {
  try {
    const bridgeStatus = await mt5BridgeRequest('GET', '/status')
    res.json({ status: 'healthy', service: 'AURUM AI', gateway: bridgeStatus })
  } catch {
    res.json({ status: 'healthy', service: 'AURUM AI', gateway: { mode: 'mock', mt5_package_available: false } })
  }
})

// MT5 Connect
router.post('/mt5/connect', authMiddleware, async (req, res) => {
  const result = await mt5BridgeRequest('POST', '/connect')
  res.json(result)
})

// MT5 Disconnect
router.post('/mt5/disconnect', authMiddleware, async (req, res) => {
  const result = await mt5BridgeRequest('POST', '/disconnect')
  res.json(result)
})

// Auth/me endpoint for frontend compatibility
router.get('/auth/me', authMiddleware, (req, res) => {
  const db = getDB()
  const user = db.prepare('SELECT id, email, nickname, role, plan FROM users WHERE id = ?').get(req.userId)
  if (!user) return res.status(404).json({ status: 'error', message: 'User not found' })
  res.json({ id: user.id, username: user.email, nickname: user.nickname, role: user.role, plan: user.plan, is_active: 1, source: 'wss' })
})

// Auto status endpoint
router.get('/auto/status', authMiddleware, (req, res) => {
  res.json({ status: 'success', scheduler: { enabled: false, status: 'disabled', running: false } })
})

export default router
