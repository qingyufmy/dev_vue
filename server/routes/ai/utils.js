// ai/utils.js — 纯函数工具层，无外部依赖

import { parseBeijing } from '../../db.js'

export const DEFAULT_PROMPT = 'You are a disciplined trading analyst. Return one strict JSON object.'

export const STRATEGY_TIMEFRAME_COUNTS = { H4: 50, H1: 80, M15: 100, M5: 60 }
// Legacy exports are retained for old callers and stored snapshots.  v6
// runtime callers resolve their period-specific target through
// chan-window-policy.js instead of these global limits.
export const CHAN_HISTORY_COUNT = 300
export const CHAN_MAX_HISTORY_COUNT = 2000
export const CHAN_ALGORITHM_VERSION = 'chan_structure_v6'

const BROKER_SUFFIX_RE = /^([A-Z0-9]{4,12})\.(?:a|s|c|pro|std|z|ecn|m|raw|mini)$/i
const GENERIC_MARKET_SUFFIX_RE = /^([A-Z0-9]{6,12})\.[A-Z0-9_-]{1,16}$/i
export function stripBrokerSuffix(sym) {
  const normalized = String(sym || '').trim().toUpperCase()
  const knownSuffix = BROKER_SUFFIX_RE.exec(normalized)?.[1]
  if (knownSuffix) return knownSuffix
  // Brokers frequently add proprietary suffixes to six-character FX, metal
  // and crypto symbols. Accept those without collapsing short equity symbols
  // such as BRK.B into the same instrument.
  return GENERIC_MARKET_SUFFIX_RE.exec(normalized)?.[1] || normalized
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
    ...(Number.isFinite(Number(r.time_utc_msc)) ? { time_utc_msc:Number(r.time_utc_msc) } : {}),
    ...(Number.isFinite(Number(r.time_server_msc)) ? { time_server_msc:Number(r.time_server_msc) } : {}),
    ...(Number.isFinite(Number(r.captured_at_utc_msc)) ? { captured_at_utc_msc:Number(r.captured_at_utc_msc) } : {}),
    open: round5(parseFloat(r.open || 0)),
    high: round5(parseFloat(r.high || 0)),
    low: round5(parseFloat(r.low || 0)),
    close: round5(parseFloat(r.close || 0)),
    tick_volume: parseInt(r.tick_volume || 0),
    spread: parseInt(r.spread || 0),
  }))
}

const pad = n => String(n).padStart(2, '0')

export function utcToMt5Time(str, timezoneOffsetMinutes = null) {
  if (!str) return null
  try {
    const d = parseBeijing(str)
    if (!d) return str
    if (timezoneOffsetMinutes === null || timezoneOffsetMinutes === undefined || timezoneOffsetMinutes === '') return null
    const offset = Number(timezoneOffsetMinutes)
    if (!Number.isInteger(offset) || offset < -720 || offset > 840) return null
    const shifted = new Date(d.getTime() + offset * 60_000)
    return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth()+1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
  } catch { return str }
}

export function utcMscToTerminalTime(utcMsc, timezoneOffsetMinutes = null) {
  const timestamp = Number(utcMsc)
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null
  if (timezoneOffsetMinutes === null || timezoneOffsetMinutes === undefined || timezoneOffsetMinutes === '') return null
  const offset = Number(timezoneOffsetMinutes)
  if (!Number.isInteger(offset) || offset < -720 || offset > 840) return null
  const shifted = new Date(timestamp + offset * 60_000)
  if (!Number.isFinite(shifted.getTime())) return null
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth()+1)}-${pad(shifted.getUTCDate())} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`
}

export function terminalOffsetFromClockPairs(pairs = []) {
  const offsets = []
  for (const pair of Array.isArray(pairs) ? pairs : []) {
    const serverMsc = Number(pair?.time_server_msc)
    const utcMsc = Number(pair?.time_utc_msc)
    if (!Number.isFinite(serverMsc) || !Number.isFinite(utcMsc) || serverMsc <= 0 || utcMsc <= 0) continue
    const rawMinutes = (serverMsc - utcMsc) / 60_000
    const offset = Math.round(rawMinutes)
    if (!Number.isInteger(offset) || offset < -720 || offset > 840
      || Math.abs(rawMinutes - offset) > (1000 / 60_000)) continue
    offsets.push(offset)
  }
  if (offsets.length < 2 || offsets.some(value => value !== offsets[0])) return null
  return offsets[0]
}

export function signalTtlSeconds(timeframe) {
  const map = { M1: 20, M5: 45, M15: 90, M30: 180, H1: 300, H4: 900, D1: 1800 }
  return map[String(timeframe).toUpperCase()] || 120
}

export function signalAgeSeconds(createdAt, createdAtUtcMsc = null) {
  try {
    const utcMsc = Number(createdAtUtcMsc)
    if (Number.isFinite(utcMsc) && utcMsc > 0) {
      return Math.max((Date.now() - utcMsc) / 1000, 0)
    }
    const created = parseBeijing(createdAt)
    if (!created) return 999999
    return Math.max((Date.now() - created.getTime()) / 1000, 0)
  } catch { return 999999 }
}

export function attachSignalTiming(signal, timezoneOffsetMinutes = null) {
  const ttl = signalTtlSeconds(signal.timeframe || '')
  const age = signalAgeSeconds(signal.created_at, signal.created_at_utc_msc)
  let storedDecision = null
  if (signal.decision_json && typeof signal.decision_json === 'object') storedDecision = signal.decision_json
  else if (typeof signal.decision_json === 'string') {
    try { storedDecision = JSON.parse(signal.decision_json) } catch { storedDecision = null }
  }
  const executionValidUntilUtcMsc = Number(
    signal.execution_valid_until_utc_msc ?? storedDecision?.execution_valid_until_utc_msc,
  )
  const hasExecutionDeadline = Number.isFinite(executionValidUntilUtcMsc) && executionValidUntilUtcMsc > 0
  signal.ttl_seconds = ttl
  signal.age_seconds = Math.round(age * 10) / 10
  signal.expires_at = signal.created_at
    ? (() => { const d = parseBeijing(signal.created_at); if (!d) return null; d.setSeconds(d.getSeconds() + ttl); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` })()
    : null
  signal.execution_valid_until_utc_msc = hasExecutionDeadline ? Math.trunc(executionValidUntilUtcMsc) : null
  signal.is_stale = age > ttl || (hasExecutionDeadline && Date.now() > executionValidUntilUtcMsc)
  const storedClock = {
    timezone_offset_minutes:signal.terminal_timezone_offset_minutes,
    clock_status:signal.terminal_clock_status,
  }
  const storedOffset = storedClock.timezone_offset_minutes === null
    || storedClock.timezone_offset_minutes === undefined || storedClock.timezone_offset_minutes === ''
    ? Number.NaN : Number(storedClock.timezone_offset_minutes)
  const storedStatus = String(storedClock.clock_status || '').trim().toLowerCase()
  const storedTrusted = Number.isInteger(storedOffset) && storedOffset >= -720 && storedOffset <= 840
    && Boolean(storedStatus) && !['unknown', 'unavailable', 'unverified', 'calibrating', 'fallback'].includes(storedStatus)
  const fallbackOffset = timezoneOffsetMinutes === null || timezoneOffsetMinutes === undefined || timezoneOffsetMinutes === ''
    ? Number.NaN : Number(timezoneOffsetMinutes)
  const offset = storedTrusted ? storedOffset : fallbackOffset
  signal.mt5_timezone_offset_minutes = Number.isInteger(offset) && offset >= -720 && offset <= 840
    ? offset : null
  signal.created_at_mt5 = utcMscToTerminalTime(signal.created_at_utc_msc, signal.mt5_timezone_offset_minutes)
    || utcToMt5Time(signal.created_at, signal.mt5_timezone_offset_minutes)
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
  const source = typeof content === 'string' ? content : String(content == null ? '' : content)
  let candidateCount = 0

  // Provider responses may contain Markdown, a short explanation, multiple
  // JSON examples, or a JSON value with nested objects.  Do not use the last
  // closing brace as the boundary: a trailing example/brace can otherwise
  // turn an otherwise valid response into a parse error.  Instead, scan each
  // opening brace and find its matching closing brace while respecting JSON
  // string escapes, then accept the first complete plain object that parses.
  for (let start = 0; start < source.length; start += 1) {
    if (source[start] !== '{') continue
    candidateCount += 1
    let depth = 0
    let inString = false
    let escaped = false
    let end = -1
    for (let index = start; index < source.length; index += 1) {
      const character = source[index]
      if (inString) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '"') inString = false
        continue
      }
      if (character === '"') {
        inString = true
        continue
      }
      if (character === '{') depth += 1
      else if (character === '}') {
        depth -= 1
        if (depth === 0) {
          end = index
          break
        }
        if (depth < 0) break
      }
    }
    if (end < 0 || inString || depth !== 0) continue
    try {
      const parsed = JSON.parse(source.slice(start, end + 1))
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {
      // Continue scanning later braces.  A malformed candidate can contain a
      // valid nested object or precede a valid JSON object in the same reply.
    }
  }

  if (candidateCount === 0) throw new Error('ai_response_missing_json_object')
  const error = new Error(`ai_response_invalid_json_object:chars=${source.length},candidates=${candidateCount}`)
  error.code = 'ai_response_invalid_json_object'
  throw error
}
