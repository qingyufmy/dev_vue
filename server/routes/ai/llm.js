// ai/llm.js — AI 推理 + 信号标准化

import { queryOne } from '../../db.js'
import { DEFAULT_PROMPT, stripTimeframeTags, round2, parseJsonObject, aiFailureHold } from './utils.js'

const DEFAULT_OUTPUT_FORMAT = JSON.stringify({
  signal_type: "buy | sell | hold",
  confidence: "0.00-1.00",
  recommended_volume: "手数",
  analysis: "简要分析",
  reasoning: "详细推理过程",
  stop_loss_price: "止损价",
  take_profit_1_price: "止盈1",
  take_profit_2_price: "止盈2",
  take_profit_3_price: "止盈3"
}, null, 2)

export async function requestJsonObject({ url, apiKey, model, temperature, maxTokens, messages, timeout = 45000 }) {
  if (apiKey && /[^ -~]/.test(apiKey)) {
    throw new Error('API key contains non-ASCII characters, please check your configuration')
  }
  const body = { model, temperature, max_tokens: maxTokens, messages }
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })
  if (!response.ok) throw new Error(`LLM HTTP ${response.status}`)
  const data = await response.json()
  const msg = data.choices?.[0]?.message
  if (!msg) throw new Error(`LLM response missing choices[0].message, status=${response.status}, body=${JSON.stringify(data).substring(0, 300)}`)
  const content = msg.content || msg.reasoning_content || ''
  if (!content) throw new Error('LLM response content is empty')
  try {
    return parseJsonObject(content)
  } catch (exc) {
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
      signal: AbortSignal.timeout(timeout),
    })
    if (!repairResp.ok) throw new Error(`LLM repair HTTP ${repairResp.status}`)
    const repairedData = await repairResp.json()
    const repairedMsg = repairedData.choices?.[0]?.message
    if (!repairedMsg) throw new Error(`LLM repair response missing choices[0].message`)
    const repaired = repairedMsg.content || repairedMsg.reasoning_content || ''
    if (!repaired) throw new Error('LLM repair response content is empty')
    return parseJsonObject(repaired)
  }
}

export async function maybeAiSignal(db, config, market) {
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
    const prompt = stripTimeframeTags(config.system_prompt || DEFAULT_PROMPT)

    // Load output schema from DB
    let outputFormat = ''
    try {
      const schema = await queryOne('SELECT schema_json FROM ai_signal_schema WHERE is_active = 1 LIMIT 1')
      if (schema?.schema_json) outputFormat = schema.schema_json
    } catch {}
    if (!outputFormat) outputFormat = DEFAULT_OUTPUT_FORMAT

    const fullPrompt = prompt + '\n\n## 输出格式\n你必须返回以下 JSON 结构：\n' + outputFormat

    // Check if prompt wants Chan theory data
    const useChan = /\{\{USE_CHAN\}\}/.test(config.system_prompt || '')
    const cleanPrompt = fullPrompt.replace(/\{\{USE_CHAN\}\}/g, '')

    const aiPayload = {
      symbol: market.symbol, timeframe: market.timeframe, timestamp: market.timestamp,
      latest_price: market.latest_price, price_change: market.price_change,
      price_change_pct: market.price_change_pct, account: market.account,
      positions: market.positions, kline_count: market.kline_count,
    }
    if (market.strategy_context) {
      const ctx = { ...market.strategy_context }
      // Strip chan data if prompt doesn't have {{USE_CHAN}}
      if (!useChan && ctx.timeframes) {
        for (const tf of Object.keys(ctx.timeframes)) {
          if (ctx.timeframes[tf]?.summary) {
            const s = { ...ctx.timeframes[tf].summary }
            delete s.chan
            ctx.timeframes[tf] = { ...ctx.timeframes[tf], summary: s }
          }
        }
      }
      aiPayload.strategy_context = ctx
    }
    const parsed = await requestJsonObject({
      url, apiKey,
      model: config.model_name || 'deepseek-chat',
      temperature: parseFloat(config.temperature || 0.7),
      maxTokens: parseInt(config.max_tokens || 2000),
      messages: [
        { role: 'system', content: fullPrompt },
        { role: 'user', content: '市场数据 JSON：\n' + JSON.stringify(aiPayload) },
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

export function normalizeAiSignal(parsed, config, market) {
  let signalType = String(parsed.signal_type || 'hold').toLowerCase()
  if (!['buy', 'sell', 'hold'].includes(signalType)) signalType = 'hold'

  const riskLevel = (config || {}).risk_level || 'medium'
  const RISK_TABLE = {
    low:    { minConfidence: 0.60, volumeMultiplier: 0.5, slAtrMult: 2.0, tp1AtrMult: 1.5, tp2AtrMult: 2.5, tp3AtrMult: 4.0 },
    medium: { minConfidence: 0.40, volumeMultiplier: 1.0, slAtrMult: 1.5, tp1AtrMult: 1.5, tp2AtrMult: 2.5, tp3AtrMult: 4.0 },
    high:   { minConfidence: 0.25, volumeMultiplier: 1.5, slAtrMult: 1.0, tp1AtrMult: 1.0, tp2AtrMult: 2.0, tp3AtrMult: 3.0 },
  }
  const risk = RISK_TABLE[riskLevel] || RISK_TABLE.medium

  const maxPosition = parseFloat((config || {}).max_position_size || 0.05) * risk.volumeMultiplier
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
    calibrated = rawConfidence * 0.85 + dataConfidence * 0.15
  }

  parsed.confidence = round2(Math.max(0.05, Math.min(0.95, calibrated)))

  if (signalType !== 'hold' && parsed.confidence < risk.minConfidence) {
    signalType = 'hold'
    parsed.signal_type = 'hold'
    parsed.recommended_volume = 0
    return parsed
  }

  parsed.signal_type = signalType
  parsed.recommended_volume = recommendedVolume

  if (signalType !== 'hold') {
    const price = market.latest_price || 0
    const atr = market.atr_14 || 0
    if (atr > 0 && price > 0) {
      if (!parsed.stop_loss_price) {
        parsed.stop_loss_price = signalType === 'buy'
          ? round2(price - atr * risk.slAtrMult) : round2(price + atr * risk.slAtrMult)
      }
      if (!parsed.take_profit_1_price) {
        parsed.take_profit_1_price = signalType === 'buy'
          ? round2(price + atr * risk.tp1AtrMult) : round2(price - atr * risk.tp1AtrMult)
      }
      if (!parsed.take_profit_2_price) {
        parsed.take_profit_2_price = signalType === 'buy'
          ? round2(price + atr * risk.tp2AtrMult) : round2(price - atr * risk.tp2AtrMult)
      }
      if (!parsed.take_profit_3_price) {
        parsed.take_profit_3_price = signalType === 'buy'
          ? round2(price + atr * risk.tp3AtrMult) : round2(price - atr * risk.tp3AtrMult)
      }
    }
  }

  return parsed
}
