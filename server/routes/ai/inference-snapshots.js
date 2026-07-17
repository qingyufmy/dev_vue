import crypto from 'crypto'
import { beijingNow, queryOne } from '../../db.js'
import { stripBrokerSuffix } from './utils.js'

export const MAX_INFERENCE_SNAPSHOT_BYTES = 512 * 1024
const SECRET_KEY = /(api[_-]?key|authorization|credential|password|secret|token)/i
const ACCOUNT_PRIVATE_KEY = new Set([
  'account', 'balance', 'equity', 'credit', 'margin', 'free_margin', 'margin_level',
  'positions', 'pending_orders', 'profit', 'total_profit', 'risk_level', 'personal_risk',
])

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex')
}

function clean(value, seen = new WeakSet()) {
  if (Array.isArray(value)) return value.map(item => clean(item, seen))
  if (!value || typeof value !== 'object') return value
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue
    out[key] = clean(item, seen)
  }
  seen.delete(value)
  return out
}

export function sanitizeInferenceEvidence(value) {
  return clean(value)
}

function stripAccountPrivateData(value) {
  if (Array.isArray(value)) return value.map(stripAccountPrivateData)
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (ACCOUNT_PRIVATE_KEY.has(key.toLowerCase())) continue
    out[key] = stripAccountPrivateData(item)
  }
  return out
}

export function buildSharedMarketSnapshot(market, { standardSymbol, volumeMin, volumeMax, marketSource = 'platform_market_bridge' } = {}) {
  const technicalFields = [
    'timestamp', 'latest_price', 'price_change', 'price_change_pct', 'sma_20', 'sma_50', 'ema_12', 'ema_26',
    'avg_volatility', 'recent_high_20', 'recent_low_20', 'range_position_20', 'sma_distance_pct',
    'momentum_3_pct', 'momentum_10_pct', 'momentum_20_pct', 'volatility_pct', 'macd', 'rsi_14',
    'bollinger', 'atr_14', 'atr_14_closed', 'atr_anchor', 'atr_anchor_tf', 'support_resistance',
    'kline_patterns', 'volume', 'strategy_score', 'kline_count', 'strategy_context',
    'primary_timeframe', 'requested_timeframes', 'used_timeframes', 'missing_timeframes',
  ]
  const result = {
    standard_symbol: stripBrokerSuffix(String(standardSymbol || market?.symbol || '')).toUpperCase(),
    symbol: stripBrokerSuffix(String(standardSymbol || market?.symbol || '')).toUpperCase(),
    timeframe: market?.timeframe,
    market_source: marketSource,
    ai_volume_range: { min: Number(volumeMin), max: Number(volumeMax) },
  }
  for (const key of technicalFields) if (market?.[key] !== undefined) result[key] = stripAccountPrivateData(clean(market[key]))
  const visualizationKlines = market?.strategy_context?.visualization_klines
  if (visualizationKlines && result.strategy_context) {
    Object.defineProperty(result.strategy_context, 'visualization_klines', { value: visualizationKlines, enumerable: false })
  }
  return result
}

function extractKlines(market) {
  const visualization = market?.strategy_context?.visualization_klines
  if (visualization && typeof visualization === 'object') return visualization
  const frames = market?.strategy_context?.timeframes || {}
  const result = {}
  for (const [timeframe, value] of Object.entries(frames)) {
    if (Array.isArray(value?.klines)) result[timeframe] = value.klines
  }
  return result
}

function stripEmbeddedKlines(market) {
  const result = clean(market || {})
  const context = result?.strategy_context
  if (!context || typeof context !== 'object') return result
  delete context.visualization_klines
  for (const value of Object.values(context.timeframes || {})) {
    if (value && typeof value === 'object') delete value.klines
  }
  return result
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

export function prepareInferenceSnapshot(input, maxBytes = MAX_INFERENCE_SNAPSHOT_BYTES) {
  const full = sanitizeInferenceEvidence({
    system_prompt: input.systemPrompt || '', user_prompt: input.userPrompt || '',
    market_snapshot: input.marketSnapshot || {}, klines: input.klines || extractKlines(input.marketSnapshot),
  })
  const contentHash = sha256(JSON.stringify(full))
  // K-lines have their own column. Keeping the same arrays inside the market
  // snapshot doubled every record and made size compaction discard old bars
  // required to position Chan structures accurately.
  let stored = { ...full, market_snapshot: stripEmbeddedKlines(full.market_snapshot) }
  const omitted = []
  if (byteLength(stored) > maxBytes) {
    const compactKlines = {}
    for (const [tf, rows] of Object.entries(stored.klines || {})) compactKlines[tf] = Array.isArray(rows) ? rows.slice(-50) : rows
    stored = { ...stored, klines: compactKlines }
    omitted.push('klines_before_latest_50')
  }
  if (byteLength(stored) > maxBytes) {
    stored.user_prompt = `[evidence omitted; sha256=${sha256(full.user_prompt)}]`
    omitted.push('rendered_user_prompt_body')
  }
  if (byteLength(stored) > maxBytes) {
    stored.market_snapshot = { evidence_ref: `sha256:${sha256(JSON.stringify(full.market_snapshot))}` }
    omitted.push('market_snapshot_body')
  }
  if (byteLength(stored) > maxBytes) {
    stored.system_prompt = `[evidence omitted; sha256=${sha256(full.system_prompt)}]`
    omitted.push('rendered_system_prompt_body')
  }
  if (byteLength(stored) > maxBytes) throw new Error('inference_snapshot_exceeds_hard_limit')
  return {
    ...input,
    systemPrompt: stored.system_prompt,
    userPrompt: stored.user_prompt,
    marketSnapshot: stored.market_snapshot,
    klines: stored.klines,
    promptHash: sha256(`${full.system_prompt}\n${full.user_prompt}`),
    contentHash,
    evidenceStatus: omitted.length ? 'incomplete' : 'complete',
    omittedFields: omitted,
    byteSize: byteLength(stored),
  }
}

export async function persistInferenceSnapshotTx(run, input) {
  const row = prepareInferenceSnapshot(input)
  const [result] = await run(`INSERT INTO inference_snapshots
    (signal_id, strategy_id, strategy_version, strategy_scope, owner_user_id, standard_symbol, market_source,
     system_prompt, user_prompt, prompt_hash, model_profile_id, provider, model_name, credential_source,
     output_schema_version, klines_json, market_snapshot_json, memory_mode, evidence_status,
     omitted_fields_json, content_hash, byte_size, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    row.signalId || null, row.strategyId ?? null, row.strategyVersion || 1, row.strategyScope, row.ownerUserId || 0,
    row.standardSymbol, row.marketSource, row.systemPrompt, row.userPrompt, row.promptHash,
    row.modelProfileId || null, row.provider || null, row.modelName || null, row.credentialSource || 'none',
    row.outputSchemaVersion, JSON.stringify(row.klines || {}), JSON.stringify(row.marketSnapshot || {}),
    row.memoryMode || 'off', row.evidenceStatus, JSON.stringify(row.omittedFields), row.contentHash, row.byteSize,
    row.createdAt || beijingNow(),
  ])
  return result.insertId
}

function parseJson(value, fallback) {
  if (value == null || value === '') return fallback
  if (typeof value === 'object') return value
  try { return JSON.parse(value) } catch { return fallback }
}

export function inferenceVisualizationSnapshot(row) {
  if (!row) return null
  const klines = parseJson(row.klines_json, {})
  const marketSnapshot = clean(parseJson(row.market_snapshot_json, {}))
  const frames = marketSnapshot?.strategy_context?.timeframes || {}
  for (const value of Object.values(frames)) {
    if (value && typeof value === 'object') delete value.klines
  }
  return {
    id: Number(row.id),
    strategy_id: row.strategy_id == null ? null : Number(row.strategy_id),
    standard_symbol: row.standard_symbol || null,
    market_source: row.market_source || null,
    evidence_status: row.evidence_status || 'incomplete',
    omitted_fields: parseJson(row.omitted_fields_json, []),
    klines,
    market_snapshot: marketSnapshot,
    created_at: row.created_at || null,
  }
}

export async function getInferenceVisualizationSnapshot(signalId) {
  const id = Number(signalId)
  if (!id) return null
  const row = await queryOne(`SELECT id, strategy_id, standard_symbol, market_source, evidence_status,
    omitted_fields_json, klines_json, market_snapshot_json, created_at
    FROM inference_snapshots WHERE signal_id = ? ORDER BY id DESC LIMIT 1`, [id])
  return inferenceVisualizationSnapshot(row)
}
