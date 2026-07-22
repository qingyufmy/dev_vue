// ai/utils.js — 纯函数工具层，无外部依赖

import { parseBeijing } from '../../db.js'

export const DEFAULT_PROMPT = 'You are a disciplined trading analyst. Return strict JSON with signal_type, confidence, recommended_volume, analysis, reasoning, stop_loss_price, take_profit_1_price, take_profit_2_price, take_profit_3_price.'

export const STRATEGY_TIMEFRAME_COUNTS = { H4: 50, H1: 80, M15: 100, M5: 60 }
export const CHAN_HISTORY_COUNT = 300
export const CHAN_MAX_HISTORY_COUNT = 1000

const BROKER_SUFFIX_RE = /\.(a|s|c|pro|std|z|ecn|m|raw|mini)$/i
export function stripBrokerSuffix(sym) {
  return String(sym || '').replace(BROKER_SUFFIX_RE, '').toUpperCase()
}

const MTF_TAG_RE = /\{\{MTF:([A-Z]\d+):(\d+)\}\}/g
const ATF_TAG_RE = /\{\{ATF:([A-Z]\d+):(\d+)\}\}/g
const CTF_TAG_RE = /\{\{CTF:([A-Z]\d+):(\d+)\}\}/g
const ALL_TF_TAG_RE = /\{\{[MAC]TF:([A-Z]\d+):(\d+)\}\}/gi
const USE_CHAN_TAG_RE = /\{\{USE_CHAN\}\}/gi

export function parseTimeframeTags(prompt, mode = 'manual') {
  if (!prompt) return []
  const re = mode === 'auto' ? ATF_TAG_RE : mode === 'close' ? CTF_TAG_RE : MTF_TAG_RE
  const tags = []
  let m
  while ((m = re.exec(prompt)) !== null) {
    tags.push({ tf: m[1].toUpperCase(), count: Math.min(Math.max(parseInt(m[2]) || 100, 10), 500) })
  }
  return tags
}

export function stripTimeframeTags(prompt) {
  return prompt ? prompt.replace(ALL_TF_TAG_RE, '').replace(/\n{3,}/g, '\n\n').trim() : prompt
}

export function parseLegacyTimeframeTags(prompt) {
  if (!prompt) return []
  const tags = []
  const seen = new Set()
  const re = /\{\{[MAC]TF:([A-Z]\d+):(\d+)\}\}/gi
  let match
  while ((match = re.exec(String(prompt))) !== null) {
    const tf = match[1].toUpperCase()
    if (seen.has(tf)) continue
    seen.add(tf)
    tags.push({ tf, count: Math.min(Math.max(parseInt(match[2]) || 100, 10), 500) })
  }
  return tags
}

export function hasLegacyUseChanTag(prompt) {
  return /\{\{USE_CHAN\}\}/i.test(String(prompt || ''))
}

export function stripStrategyControlTags(prompt) {
  if (!prompt) return prompt
  return String(prompt)
    .replace(ALL_TF_TAG_RE, '')
    .replace(USE_CHAN_TAG_RE, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function round2(v) { return Math.round(v * 100) / 100 }
export function round3(v) { return Math.round(v * 1000) / 1000 }
export function round5(v) { return Math.round(v * 100000) / 100000 }
export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

export function compactRates(rates) {
  return rates.map(r => ({
    time: r.time,
    open: round5(parseFloat(r.open || 0)),
    high: round5(parseFloat(r.high || 0)),
    low: round5(parseFloat(r.low || 0)),
    close: round5(parseFloat(r.close || 0)),
    tick_volume: parseInt(r.tick_volume || 0),
  }))
}

const pad = n => String(n).padStart(2, '0')

export function utcToMt5Time(str, timezoneOffsetMinutes = 180) {
  if (!str) return null
  try {
    const d = parseBeijing(str)
    if (!d) return str
    const offset = Number.isFinite(Number(timezoneOffsetMinutes)) ? Math.trunc(Number(timezoneOffsetMinutes)) : 180
    const shifted = new Date(d.getTime() + offset * 60_000)
    return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth()+1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
  } catch { return str }
}

export function signalTtlSeconds(timeframe) {
  const map = { M1: 20, M5: 45, M15: 90, M30: 180, H1: 300, H4: 900, D1: 1800 }
  return map[String(timeframe).toUpperCase()] || 120
}

export function signalAgeSeconds(createdAt) {
  try {
    const created = parseBeijing(createdAt)
    if (!created) return 999999
    return Math.max((Date.now() - created.getTime()) / 1000, 0)
  } catch { return 999999 }
}

export function attachSignalTiming(signal, timezoneOffsetMinutes = 180) {
  const ttl = signalTtlSeconds(signal.timeframe || '')
  const age = signalAgeSeconds(signal.created_at)
  signal.ttl_seconds = ttl
  signal.age_seconds = Math.round(age * 10) / 10
  signal.expires_at = signal.created_at
    ? (() => { const d = parseBeijing(signal.created_at); if (!d) return null; d.setSeconds(d.getSeconds() + ttl); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` })()
    : null
  signal.is_stale = age > ttl
  signal.mt5_timezone_offset_minutes = Number.isFinite(Number(timezoneOffsetMinutes)) ? Math.trunc(Number(timezoneOffsetMinutes)) : 180
  signal.created_at_mt5 = utcToMt5Time(signal.created_at, signal.mt5_timezone_offset_minutes)
  signal.expires_at_mt5 = utcToMt5Time(signal.expires_at, signal.mt5_timezone_offset_minutes)
  return signal
}

export function timeframeIntervalMs(tf) {
  const map = { 'M1': 60_000, 'M5': 300_000, 'M15': 900_000, 'M30': 1_800_000, 'H1': 3_600_000, 'H4': 14_400_000, 'D1': 86_400_000 }
  return map[String(tf).toUpperCase()] || 900_000
}

export function aiFailureHold(market, reason) {
  return {
    signal_type: 'hold',
    // Zero is a UI sentinel for unavailable model confidence, not a measured
    // market-confidence score. It prevents an inference error looking like a
    // valid 50% HOLD conclusion.
    confidence: 0,
    recommended_volume: 0.0,
    position_size_tier: 'observe',
    position_size_factor: 0,
    position_size_reason: '模型未形成可执行仓位建议',
    position_action: 'observe',
    pending_action: 'none',
    management_direction: 'none',
    entry_method: 'observe',
    limit_price: null,
    stop_limit_price: null,
    pending_valid_until: null,
    analysis: `${market.symbol} ${market.timeframe}: AI 推理返回未能形成可执行 JSON，系统按保护规则观望。`,
    reasoning: `AI 模型推理失败或输出格式不符合执行合约：${reason}。为确保交易严格按策略提示词执行，本轮不使用本地规则替代开仓。`,
    stop_loss_price: null,
    take_profit_1_price: null,
    take_profit_2_price: null,
    take_profit_3_price: null,
    _inference_source: 'ai_error_hold',
  }
}

export function parseJsonObject(content) {
  const start = content.indexOf('{')
  const end = content.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) throw new Error('ai_response_missing_json_object')
  return JSON.parse(content.substring(start, end + 1))
}
