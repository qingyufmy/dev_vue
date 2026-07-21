import { beijingNow, queryAll, queryOne, queryRun } from '../../db.js'
import { sanitizeMemoryText } from './memory-system.js'
import { sha256 } from './inference-snapshots.js'

const VALID_POLICY_MODES = new Set(['off', 'shadow', 'active'])
const VALID_ITEM_STATUSES = new Set(['candidate', 'active', 'revoked'])
const VALID_MEMORY_TIERS = new Set(['short', 'long'])
const ACCOUNT_SPECIFIC_PATTERN = /(账户|账号|余额|净值|保证金|仓位|持仓|挂单|订单号|票号|手数|入金|出金|盈利|亏损|回撤|account|login|balance|equity|margin|position|pending\s*order|ticket|lot\b|volume\b|profit|loss|drawdown)/i

const parse = (value, fallback = null) => {
  try { return value == null ? fallback : JSON.parse(value) } catch { return fallback }
}

const textValue = value => String(value || '').trim().toLowerCase()
const stringList = value => [...new Set((Array.isArray(value) ? value : value ? [value] : [])
  .map(item => textValue(item)).filter(Boolean))]

function signalDirection(value) {
  const signal = textValue(value)
  if (signal.startsWith('buy') || signal === 'up' || signal === 'bullish') return 'up'
  if (signal.startsWith('sell') || signal === 'down' || signal === 'bearish') return 'down'
  return signal === 'neutral' || signal === 'hold' ? 'neutral' : null
}

function primaryChan(market = {}, timeframe = null) {
  return market.chan
    || market.strategy_context?.timeframes?.[timeframe]?.summary?.chan
    || market.strategy_context?.timeframes?.[timeframe]?.chan
    || null
}

export function buildPlatformExperienceRetrievalContext({ strategyVersion = 1, symbol = null, timeframe = null, market = {}, allowedEntryMethods = [] } = {}) {
  const chan = primaryChan(market, timeframe)
  const momentum = Number(market.strategy_score?.momentum_alignment || 0)
  const smaDistance = Number(market.sma_distance_pct || 0)
  const fallbackDirection = momentum > 0 && smaDistance >= 0 ? 'up' : momentum < 0 && smaDistance <= 0 ? 'down' : 'neutral'
  const trendDirection = signalDirection(chan?.trend_state?.direction) || fallbackDirection
  const trendStrength = Number(market.strategy_score?.trend_strength || 0)
  const marketRegime = textValue(market.market_regime || market.strategy_context?.market_regime || chan?.trend_state?.state)
    || (trendStrength >= 0.55 && trendDirection !== 'neutral' ? `${trendDirection}trend` : 'range')
  const volatility = Number(market.volatility_pct)
  const volatilityBucket = !Number.isFinite(volatility) ? null : volatility >= 0.35 ? 'high' : volatility >= 0.12 ? 'normal' : 'low'
  const divergence = !chan ? null : chan?.divergence?.confirmed ? textValue(chan.divergence.type) : chan?.forming_divergence?.type && chan.forming_divergence.type !== 'none'
    ? `forming_${textValue(chan.forming_divergence.type)}` : 'none'
  return {
    strategy_version:Number(strategyVersion || 1),
    symbol:textValue(symbol).toUpperCase() || null, timeframe:textValue(timeframe).toUpperCase() || null,
    trend_direction:trendDirection, market_regime:marketRegime, volatility_bucket:volatilityBucket,
    allowed_entry_methods:stringList(allowedEntryMethods), chan_trend_state:textValue(chan?.trend_state?.state) || null,
    chan_segment_direction:signalDirection(chan?.current_segment?.dir), chan_divergence:divergence,
    chan_center_state:textValue(chan?.current_center?.status || chan?.active_center?.status) || null,
    chan_reliability:textValue(chan?.reliability) || null,
  }
}

export function platformExperienceApplicability(item, retrievalContext) {
  const context = parse(item.context_json, {}) || {}
  const applicable = context.applicable_when && typeof context.applicable_when === 'object' ? context.applicable_when : context
  const avoid = context.avoid_when && typeof context.avoid_when === 'object' ? context.avoid_when : {}
  const reasons = ['strategy_match']
  let score = 55
  const expectedStrategyVersion = Number(applicable.strategy_version || 0)
  if (expectedStrategyVersion && expectedStrategyVersion !== Number(retrievalContext.strategy_version || 1)) {
    return { eligible:false, score:0, reasons:['strategy_version_mismatch'] }
  }
  if (expectedStrategyVersion) { score += 8; reasons.push('strategy_version_match') }
  const scoreField = (field, weight, aliases = []) => {
    let expected = stringList(applicable[field] ?? aliases.map(key => applicable[key]).find(value => value != null))
    if (field === 'trend_direction') expected = expected.map(value => signalDirection(value) || value)
    const actual = textValue(retrievalContext[field])
    if (!expected.length || !actual) return
    if (expected.includes(actual)) { score += weight; reasons.push(`${field}_match`) }
    else { score -= Math.max(3, Math.round(weight * 0.75)); reasons.push(`${field}_mismatch`) }
  }
  const avoidField = field => {
    const blocked = stringList(avoid[field])
    const actual = textValue(retrievalContext[field])
    if (actual && blocked.includes(actual)) { score -= 100; reasons.push(`${field}_avoided`) }
  }
  const expectedMethods = stringList(applicable.entry_methods || applicable.entry_method)
  if (expectedMethods.length) {
    const overlap = expectedMethods.filter(method => retrievalContext.allowed_entry_methods.includes(method))
    if (!overlap.length) return { eligible:false, score:0, reasons:['entry_method_not_allowed'] }
    score += 6; reasons.push('entry_method_overlap')
  }
  scoreField('market_regime', 15)
  scoreField('trend_direction', 10, ['direction', 'signal_type'])
  scoreField('volatility_bucket', 6)
  scoreField('chan_trend_state', 10)
  scoreField('chan_segment_direction', 8)
  scoreField('chan_divergence', 10)
  scoreField('chan_center_state', 6)
  for (const field of ['market_regime', 'trend_direction', 'volatility_bucket', 'chan_trend_state', 'chan_segment_direction', 'chan_divergence', 'chan_center_state']) avoidField(field)
  return { eligible:score >= 50, score:Math.max(0, Math.min(100, score)), reasons }
}

export function sanitizePlatformExperienceText(value, maxLength = 4000) {
  const fragments = String(value || '').split(/(?<=[。！？!?;；\n])/u)
    .map(item => sanitizeMemoryText(item, maxLength))
    .filter(item => item && !ACCOUNT_SPECIFIC_PATTERN.test(item))
  return sanitizeMemoryText(fragments.join(' '), maxLength)
}

function buildCandidate(reviewCase, version) {
  const content = parse(version.content_json, {})
  const evidence = parse(reviewCase.evidence_json, {})
  const snapshot = evidence?.inference_time?.snapshot || {}
  const signal = evidence?.inference_time?.signal || {}
  const outcome = evidence?.post_trade?.outcome || {}
  const lessons = Array.isArray(content.lessons) ? content.lessons : []
  const lessonText = sanitizePlatformExperienceText(lessons.join('。'))
  const market = snapshot.market_snapshot || {}
  const timeframe = sanitizeMemoryText(signal.timeframe || market.timeframe || market.strategy_context?.primary_timeframe || '', 16) || null
  const retrievalContext = buildPlatformExperienceRetrievalContext({ strategyVersion:Number(snapshot.strategy_version || 1), symbol:outcome.symbol || market.symbol, timeframe, market,
    allowedEntryMethods:signal.entry_method ? [signal.entry_method] : [] })
  const context = {
    symbol: sanitizeMemoryText(outcome.symbol || market.symbol || '', 64) || null,
    timeframe,
    signal_type: sanitizeMemoryText(signal.signal_type || '', 32) || null,
    entry_methods: signal.entry_method ? [sanitizeMemoryText(signal.entry_method, 24)] : [],
    market_regime: retrievalContext.market_regime || null,
    trend_direction: retrievalContext.trend_direction || signalDirection(signal.signal_type),
    volatility_bucket: retrievalContext.volatility_bucket,
    chan_trend_state: retrievalContext.chan_trend_state,
    chan_segment_direction: retrievalContext.chan_segment_direction,
    chan_divergence: retrievalContext.chan_divergence,
    chan_center_state: retrievalContext.chan_center_state,
    strategy_version:Number(snapshot.strategy_version || 1),
  }
  return { strategyId: Number(snapshot.strategy_id), lessonText, context }
}

export async function createPlatformExperienceCandidateFromApprovedReview(caseId, adminUserId) {
  const reviewCase = await queryOne('SELECT * FROM trade_review_cases WHERE id = ? AND user_id = ?', [caseId, adminUserId])
  if (!reviewCase || reviewCase.status !== 'approved' || !reviewCase.approved_version_id) throw new Error('approved_review_required')
  const version = await queryOne('SELECT * FROM trade_review_versions WHERE id = ? AND case_id = ?', [reviewCase.approved_version_id, caseId])
  if (!version) throw new Error('approved_review_version_missing')
  const candidate = buildCandidate(reviewCase, version)
  if (!candidate.strategyId) return { skipped: true, reason: 'platform_strategy_context_missing' }
  const strategy = await queryOne("SELECT id FROM auto_prompt_types WHERE id = ? AND scope = 'platform' AND deleted_at IS NULL", [candidate.strategyId])
  if (!strategy) return { skipped: true, reason: 'platform_strategy_required' }
  if (!candidate.lessonText) return { skipped: true, reason: 'platform_experience_has_no_market_safe_lesson' }
  const existing = await queryOne('SELECT * FROM platform_strategy_experience_items WHERE review_version_id = ?', [version.id])
  if (existing) return existing
  const now = beijingNow()
  const contentHash = sha256(JSON.stringify({ strategy_id: candidate.strategyId, lesson: candidate.lessonText, context: candidate.context }))
  const result = await queryRun(`INSERT INTO platform_strategy_experience_items
    (strategy_id, memory_tier, review_case_id, review_version_id, source_admin_user_id, lesson_text,
     context_json, content_hash, status, created_at, updated_at)
    VALUES (?, 'short', ?, ?, ?, ?, ?, ?, 'candidate', ?, ?)`, [
    candidate.strategyId, caseId, version.id, adminUserId, candidate.lessonText,
    JSON.stringify(candidate.context), contentHash, now, now,
  ])
  return queryOne('SELECT * FROM platform_strategy_experience_items WHERE id = ?', [result.insertId])
}

export async function createPlatformExperienceCandidateFromApprovedPeriodReview(periodCaseId, adminUserId) {
  const reviewCase = await queryOne(`SELECT cases.*, u.role AS user_role FROM period_review_cases cases
    JOIN users u ON u.id = cases.user_id WHERE cases.id = ? AND cases.user_id = ?`, [periodCaseId, adminUserId])
  if (!reviewCase || reviewCase.status !== 'approved' || !reviewCase.approved_version_id) throw new Error('approved_period_review_required')
  if (reviewCase.user_role !== 'admin' || reviewCase.strategy_scope !== 'platform') throw new Error('platform_period_review_required')
  const version = await queryOne('SELECT * FROM period_review_versions WHERE id = ? AND period_case_id = ?', [reviewCase.approved_version_id, periodCaseId])
  if (!version) throw new Error('approved_period_review_version_missing')
  const existing = await queryOne('SELECT * FROM platform_strategy_experience_items WHERE period_review_version_id = ?', [version.id])
  if (existing) return existing
  const strategy = await queryOne("SELECT id FROM auto_prompt_types WHERE id = ? AND scope = 'platform' AND deleted_at IS NULL", [reviewCase.strategy_id])
  if (!strategy) throw new Error('platform_strategy_required')
  const content = parse(version.content_json, {})
  const fragments = reviewCase.period_type === 'daily'
    ? [...(content.daily_lessons || []), ...(content.strengths || [])]
    : [content.period_summary, ...(content.recurring_patterns || []), ...(content.strengths || []),
      ...(content.next_month_actions || []), ...(content.memory_candidates || []).map(item => item.lesson)]
  const lessonText = sanitizePlatformExperienceText(fragments.filter(Boolean).join('。'), 6000)
  if (!lessonText) return { skipped: true, reason: 'platform_experience_has_no_market_safe_lesson' }
  const context = { period_type: reviewCase.period_type, period_key: reviewCase.period_key,
    strategy_version: Number(reviewCase.strategy_version || 1), symbol: null, timeframe: null }
  const memoryTier = reviewCase.period_type === 'monthly' ? 'long' : 'short'
  const now = beijingNow()
  const contentHash = sha256(JSON.stringify({ strategy_id: Number(reviewCase.strategy_id), lesson: lessonText, context }))
  await queryRun(`INSERT IGNORE INTO platform_strategy_experience_items
    (strategy_id, memory_tier, review_case_id, review_version_id, period_review_case_id, period_review_version_id,
     period_key, source_admin_user_id, lesson_text, context_json, content_hash, status, created_at, updated_at)
    VALUES (?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?)`, [reviewCase.strategy_id, memoryTier,
    reviewCase.id, version.id, reviewCase.period_key, adminUserId, lessonText, JSON.stringify(context), contentHash, now, now])
  return queryOne('SELECT * FROM platform_strategy_experience_items WHERE period_review_version_id = ?', [version.id])
}

export async function listPlatformExperience({ strategyId = null, status = null, limit = 100 } = {}) {
  const where = []
  const params = []
  if (strategyId) { where.push('pei.strategy_id = ?'); params.push(Number(strategyId)) }
  if (status) { where.push('pei.status = ?'); params.push(String(status)) }
  params.push(Math.min(200, Math.max(1, Number(limit) || 100)))
  const suffix = where.length ? `WHERE ${where.join(' AND ')}` : ''
  return queryAll(`SELECT pei.*, apt.title AS strategy_title
    FROM platform_strategy_experience_items pei
    JOIN auto_prompt_types apt ON apt.id = pei.strategy_id
    ${suffix} ORDER BY pei.updated_at DESC, pei.id DESC LIMIT ?`, params)
}

export async function getPlatformExperiencePolicies() {
  return queryAll(`SELECT apt.id AS strategy_id, apt.title AS strategy_title,
      COALESCE(pep.mode, 'shadow') AS mode, COALESCE(pep.max_items, 5) AS max_items,
      COALESCE(pep.runtime_token_budget, 800) AS runtime_token_budget,
      COALESCE(pep.policy_version, 1) AS policy_version, pep.updated_at
    FROM auto_prompt_types apt
    LEFT JOIN platform_strategy_experience_policies pep ON pep.strategy_id = apt.id
    WHERE apt.scope = 'platform' AND apt.deleted_at IS NULL
    ORDER BY apt.sort_order, apt.id`)
}

export async function updatePlatformExperiencePolicy(strategyId, adminUserId, input = {}) {
  const id = Number(strategyId)
  const mode = String(input.mode || 'shadow')
  if (!Number.isInteger(id) || id <= 0) throw new Error('invalid_strategy_id')
  if (!VALID_POLICY_MODES.has(mode)) throw new Error('invalid_platform_experience_mode')
  const strategy = await queryOne("SELECT id FROM auto_prompt_types WHERE id = ? AND scope = 'platform' AND deleted_at IS NULL", [id])
  if (!strategy) throw new Error('platform_strategy_required')
  const existing = await queryOne('SELECT * FROM platform_strategy_experience_policies WHERE strategy_id = ?', [id])
  const maxItems = Math.min(10, Math.max(1, Number(input.max_items ?? existing?.max_items ?? 5) || 5))
  const budget = Math.min(1600, Math.max(100, Number(input.runtime_token_budget ?? existing?.runtime_token_budget ?? 800) || 800))
  const now = beijingNow()
  await queryRun(`INSERT INTO platform_strategy_experience_policies
    (strategy_id, mode, max_items, runtime_token_budget, policy_version, updated_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?)
    ON DUPLICATE KEY UPDATE mode = VALUES(mode), max_items = VALUES(max_items),
      runtime_token_budget = VALUES(runtime_token_budget), policy_version = policy_version + 1,
      updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)`,
  [id, mode, maxItems, budget, adminUserId, now, now])
  return queryOne('SELECT * FROM platform_strategy_experience_policies WHERE strategy_id = ?', [id])
}

export async function updatePlatformExperienceItem(itemId, adminUserId, status) {
  const id = Number(itemId)
  if (!Number.isInteger(id) || id <= 0) throw new Error('invalid_platform_experience_id')
  if (!VALID_ITEM_STATUSES.has(status) || status === 'candidate') throw new Error('invalid_platform_experience_status')
  const existing = await queryOne('SELECT * FROM platform_strategy_experience_items WHERE id = ?', [id])
  if (!existing) throw new Error('platform_experience_not_found')
  const now = beijingNow()
  let version = existing.platform_version
  if (status === 'active' && existing.status !== 'active') {
    const row = await queryOne('SELECT COALESCE(MAX(platform_version), 0) AS max_version FROM platform_strategy_experience_items WHERE strategy_id = ?', [existing.strategy_id])
    version = Number(row?.max_version || 0) + 1
  }
  await queryRun(`UPDATE platform_strategy_experience_items SET status = ?, platform_version = ?,
      published_by = ?, published_at = ?, revoked_at = ?, updated_at = ? WHERE id = ?`, [
    status, version || null, status === 'active' ? adminUserId : existing.published_by,
    status === 'active' ? now : existing.published_at,
    status === 'revoked' ? now : null, now, id,
  ])
  return queryOne('SELECT * FROM platform_strategy_experience_items WHERE id = ?', [id])
}

export async function deleteRevokedPlatformExperienceItem(itemId) {
  const id = Number(itemId)
  if (!Number.isInteger(id) || id <= 0) throw new Error('invalid_platform_experience_id')
  const existing = await queryOne('SELECT id, status FROM platform_strategy_experience_items WHERE id = ?', [id])
  if (!existing) throw new Error('platform_experience_not_found')
  if (existing.status !== 'revoked') throw new Error('platform_experience_must_be_revoked_before_delete')
  const result = await queryRun("DELETE FROM platform_strategy_experience_items WHERE id = ? AND status = 'revoked'", [id])
  if (!Number(result.changes || 0)) throw new Error('platform_experience_delete_conflict')
  return { deleted:true, id }
}

function estimateTokens(value) {
  return Math.max(1, Math.ceil(Buffer.byteLength(String(value || ''), 'utf8') / 4))
}

export async function retrievePlatformExperience({ strategyId, strategyVersion = 1, symbol = null, timeframe = null, market = {}, allowedEntryMethods = [] } = {}) {
  const boundStrategyId = Number(strategyId)
  if (!Number.isInteger(boundStrategyId) || boundStrategyId <= 0) {
    return { mode:'off', promptBlock:'', selectedItemIds:[], tokenCount:0, disabled:true, reason:'strategy_required',
      policyVersion:1, retrievalContext:null, selectionDetails:[] }
  }
  const policy = await queryOne('SELECT * FROM platform_strategy_experience_policies WHERE strategy_id = ?', [boundStrategyId])
  const mode = policy?.mode || 'shadow'
  const maxItems = Number(policy?.max_items || 5)
  const budget = Number(policy?.runtime_token_budget || 800)
  const items = await queryAll(`SELECT * FROM platform_strategy_experience_items
    WHERE strategy_id = ? AND status = 'active'
      AND (JSON_EXTRACT(context_json, '$.symbol') IS NULL OR JSON_TYPE(JSON_EXTRACT(context_json, '$.symbol')) = 'NULL'
        OR JSON_UNQUOTE(JSON_EXTRACT(context_json, '$.symbol')) = '' OR JSON_UNQUOTE(JSON_EXTRACT(context_json, '$.symbol')) = ?)
      AND (JSON_EXTRACT(context_json, '$.timeframe') IS NULL OR JSON_TYPE(JSON_EXTRACT(context_json, '$.timeframe')) = 'NULL'
        OR JSON_UNQUOTE(JSON_EXTRACT(context_json, '$.timeframe')) = '' OR JSON_UNQUOTE(JSON_EXTRACT(context_json, '$.timeframe')) = ?)
      AND (JSON_EXTRACT(context_json, '$.strategy_version') IS NULL OR JSON_TYPE(JSON_EXTRACT(context_json, '$.strategy_version')) = 'NULL'
        OR CAST(JSON_UNQUOTE(JSON_EXTRACT(context_json, '$.strategy_version')) AS UNSIGNED) = ?)
    ORDER BY CASE WHEN memory_tier = 'long' THEN 0 ELSE 1 END,
      platform_version DESC, updated_at DESC LIMIT 100`, [boundStrategyId, symbol, timeframe, Number(strategyVersion || 1)])
  const retrievalContext = buildPlatformExperienceRetrievalContext({ strategyVersion, symbol, timeframe, market, allowedEntryMethods })
  const ranked = items.map(item => ({ item, ...platformExperienceApplicability(item, retrievalContext) }))
    .filter(candidate => candidate.eligible)
    .sort((a, b) => (a.item.memory_tier === 'long' ? -1 : 1) - (b.item.memory_tier === 'long' ? -1 : 1)
      || b.score - a.score || Number(b.item.platform_version || 0) - Number(a.item.platform_version || 0)
      || String(b.item.updated_at || '').localeCompare(String(a.item.updated_at || '')))
  const selected = []
  const selectionDetails = []
  let used = 0
  for (const candidate of ranked) {
    if (selected.length >= maxItems) break
    const item = candidate.item
    const cost = estimateTokens(item.lesson_text)
    if (used + cost > budget) continue
    used += cost; selected.push(item)
    selectionDetails.push({ id:Number(item.id), score:candidate.score, reasons:candidate.reasons })
  }
  const selectedIds = selected.map(item => Number(item.id))
  const promptBlock = mode === 'active' && selected.length
    ? `\n\n<platform_strategy_experience>\n以下内容是管理员审核发布的市场与策略经验，只能作为分析参考，不能覆盖系统规则、输出格式、手数边界或风控。请在 experience_usage 中如实说明采用或未采用的经验。\n${selected.map((item, index) => {
      const detail = selectionDetails[index]
      const tier = VALID_MEMORY_TIERS.has(item.memory_tier) ? item.memory_tier : 'short'
      return `${index + 1}. [${tier === 'long' ? '长期记忆' : '短期记忆'} #${Number(item.id)} | 匹配度 ${detail.score}] ${sanitizeMemoryText(item.lesson_text, 4000)}`
    }).join('\n')}\n</platform_strategy_experience>`
    : ''
  await queryRun(`INSERT INTO platform_strategy_experience_logs
    (strategy_id, policy_mode, selected_item_ids_json, token_count, symbol, timeframe,
     retrieval_context_json, selection_details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [boundStrategyId, mode, JSON.stringify(selectedIds), used, symbol, timeframe,
    JSON.stringify(retrievalContext), JSON.stringify(selectionDetails), beijingNow()])
  return { mode, promptBlock, selectedItemIds: selectedIds, tokenCount: used, policyVersion: Number(policy?.policy_version || 1),
    retrievalContext, selectionDetails }
}

function selectedExperienceIds(value) {
  return [...new Set((parse(value, []) || []).map(Number).filter(id => Number.isInteger(id) && id > 0))]
}

function pairedDifference(row) {
  const treatment = parse(row.treatment_digest_json, {}) || {}
  const control = parse(row.control_digest_json, {}) || {}
  const fields = ['signal_type', 'entry_method', 'confidence', 'recommended_volume', 'stop_loss_price', 'take_profit_1_price', 'limit_price']
  const changedFields = row.control_digest_json ? fields.filter(key => JSON.stringify(treatment[key] ?? null) !== JSON.stringify(control[key] ?? null)) : []
  return { treatment, control:row.control_digest_json ? control : null, changed_fields:changedFields,
    direction_changed:changedFields.includes('signal_type'), execution_changed:changedFields.includes('entry_method') }
}

export async function getPlatformExperienceEvaluation({ days = 30, limit = 20 } = {}) {
  const windowDays = Math.min(90, Math.max(1, Math.trunc(Number(days) || 30)))
  const recentLimit = Math.min(50, Math.max(5, Math.trunc(Number(limit) || 20)))
  const [logs, items, pairedRows] = await Promise.all([
    queryAll(`SELECT logs.*, apt.title AS strategy_title
      FROM platform_strategy_experience_logs logs
      JOIN auto_prompt_types apt ON apt.id = logs.strategy_id
      WHERE logs.created_at >= DATE_SUB(NOW(), INTERVAL ${windowDays} DAY)
      ORDER BY logs.created_at DESC, logs.id DESC LIMIT 5000`),
    queryAll(`SELECT pei.id, pei.strategy_id, pei.lesson_text, pei.status, pei.platform_version, pei.published_at,
        apt.title AS strategy_title
      FROM platform_strategy_experience_items pei
      JOIN auto_prompt_types apt ON apt.id = pei.strategy_id
      WHERE pei.status = 'active' ORDER BY pei.strategy_id, pei.platform_version DESC, pei.id DESC`),
    queryAll(`SELECT runs.*, apt.title AS strategy_title, u.nickname AS user_nickname,
        outcomes.net_profit, outcomes.status AS outcome_status
      FROM ai_paired_inference_runs runs
      LEFT JOIN auto_prompt_types apt ON apt.id = runs.strategy_id
      LEFT JOIN users u ON u.id = runs.user_id
      LEFT JOIN signal_outcomes outcomes ON outcomes.signal_id = runs.signal_id
      WHERE runs.created_at >= DATE_SUB(NOW(), INTERVAL ${windowDays} DAY)
        AND apt.scope = 'platform'
      ORDER BY runs.created_at DESC, runs.id DESC LIMIT 500`),
  ])
  const itemMap = new Map(items.map(item => [Number(item.id), item]))
  const firstPublishedByStrategy = new Map()
  for (const item of items) {
    if (!item.published_at) continue
    const strategyId = Number(item.strategy_id)
    const current = firstPublishedByStrategy.get(strategyId)
    if (!current || String(item.published_at) < String(current)) firstPublishedByStrategy.set(strategyId, item.published_at)
  }
  // A retrieval before the strategy had any published experience is not a
  // miss. Excluding it keeps the hit rate tied to runs that could actually
  // select something.
  const evaluationLogs = logs.filter(log => {
    const firstPublished = firstPublishedByStrategy.get(Number(log.strategy_id))
    return firstPublished && String(log.created_at) >= String(firstPublished)
  })
  const strategyMap = new Map()
  const itemHits = new Map(items.map(item => [Number(item.id), 0]))
  let hits = 0; let shadowTotal = 0; let shadowHits = 0; let activeTotal = 0; let activeHits = 0; let tokens = 0
  for (const log of evaluationLogs) {
    const selected = selectedExperienceIds(log.selected_item_ids_json)
    const hit = selected.length > 0
    hits += hit ? 1 : 0; tokens += Number(log.token_count || 0)
    if (log.policy_mode === 'shadow') { shadowTotal += 1; shadowHits += hit ? 1 : 0 }
    if (log.policy_mode === 'active') { activeTotal += 1; activeHits += hit ? 1 : 0 }
    for (const id of selected) itemHits.set(id, Number(itemHits.get(id) || 0) + 1)
    const key = Number(log.strategy_id)
    const row = strategyMap.get(key) || { strategy_id:key, strategy_title:log.strategy_title, retrievals:0, hits:0, shadow_retrievals:0, shadow_hits:0, token_count:0, latest_at:null }
    row.retrievals += 1; row.hits += hit ? 1 : 0; row.token_count += Number(log.token_count || 0)
    if (log.policy_mode === 'shadow') { row.shadow_retrievals += 1; row.shadow_hits += hit ? 1 : 0 }
    if (!row.latest_at) row.latest_at = log.created_at
    strategyMap.set(key, row)
  }
  const recentRetrievals = evaluationLogs.slice(0, recentLimit).map(log => {
    const selectedIds = selectedExperienceIds(log.selected_item_ids_json)
    return { id:Number(log.id), strategy_id:Number(log.strategy_id), strategy_title:log.strategy_title,
      policy_mode:log.policy_mode, symbol:log.symbol, timeframe:log.timeframe, token_count:Number(log.token_count || 0),
      selected_item_ids:selectedIds, selected_items:selectedIds.map(id => ({ id, lesson_text:itemMap.get(id)?.lesson_text || null })),
      retrieval_context:parse(log.retrieval_context_json, {}), selection_details:parse(log.selection_details_json, []), created_at:log.created_at }
  })
  const completedPairs = pairedRows.filter(row => row.status === 'completed' || row.status === 'succeeded')
  const changedPairs = completedPairs.filter(row => pairedDifference(row).changed_fields.length > 0)
  return {
    generated_at:beijingNow(), window_days:windowDays,
    retrieval:{ observed_total:logs.length, total:evaluationLogs.length, hits, misses:evaluationLogs.length - hits,
      hit_rate:evaluationLogs.length ? hits / evaluationLogs.length : 0,
      shadow_total:shadowTotal, shadow_hits:shadowHits, shadow_hit_rate:shadowTotal ? shadowHits / shadowTotal : 0,
      active_total:activeTotal, active_hits:activeHits, token_count:tokens },
    strategies:[...strategyMap.values()].map(row => ({ ...row, hit_rate:row.retrievals ? row.hits / row.retrievals : 0,
      shadow_hit_rate:row.shadow_retrievals ? row.shadow_hits / row.shadow_retrievals : 0 })),
    items:items.map(item => ({ ...item, hit_count:Number(itemHits.get(Number(item.id)) || 0) })),
    recent_retrievals:recentRetrievals,
    paired:{ total:pairedRows.length, completed:completedPairs.length, changed:changedPairs.length,
      failed:pairedRows.filter(row => row.status === 'failed').length,
      recent_runs:pairedRows.slice(0, recentLimit).map(row => ({ id:Number(row.id), strategy_id:Number(row.strategy_id || 0),
        strategy_title:row.strategy_title || null, user_id:Number(row.user_id), user_nickname:row.user_nickname || null,
        signal_id:Number(row.signal_id || 0) || null, status:row.status, error_code:row.error_code || null,
        net_profit:row.net_profit == null ? null : Number(row.net_profit), outcome_status:row.outcome_status || null,
        created_at:row.created_at, ...pairedDifference(row) })),
    },
  }
}
