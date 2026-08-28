import { queryAll, queryOne } from '../db.js'
import { getRedis, isRedisAvailable } from '../redis.js'
import { getAiRolloutHealth } from '../routes/ai/rollout-governance.js'
import { getReviewAdminHealth } from '../routes/ai/review-workflow.js'
import { listObserverChannels, listObserverSources } from '../routes/ai/observer-channels.js'
import { stripBrokerSuffix } from '../routes/ai/utils.js'
import { getConnectedBridgeStats, getLatestBridgeMt5Clock, isBridgeAlive } from '../bridge-ws.js'

function number(value) {
  return Number(value || 0)
}

function parseUtcMs(value) {
  const timestamp = Date.parse(String(value || ''))
  return Number.isFinite(timestamp) ? timestamp : null
}

const HEALTH_STATE_RANK = {
  healthy:0,
  insufficient_data:1,
  attention:2,
  critical:3,
}

const HEALTH_USAGE_GROUPS = {
  manual:['manual'],
  model_compare:['model_compare'],
  auto_inference:['auto_private', 'auto_platform'],
  review:['review'],
  memory:['memory_compression'],
}

function healthCount(rows, key, usages) {
  return (Array.isArray(rows) ? rows : [])
    .filter(row => usages.includes(String(row?.usage || '')))
    .reduce((sum, row) => sum + number(row?.[key]), 0)
}

function latestHealthTimestamp(rows, usages) {
  const timestamps = (Array.isArray(rows) ? rows : [])
    .filter(row => usages.includes(String(row?.usage || '')))
    .map(row => parseUtcMs(row?.last_request_at))
    .filter(value => value !== null)
  return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null
}

function healthComponent(usageRows, usages, expected) {
  const sampleCount = healthCount(usageRows, 'request_count', usages)
  const failureCount = healthCount(usageRows, 'failure_count', usages)
  return {
    state:failureCount > 0 ? 'attention' : sampleCount > 0 ? 'healthy' : 'insufficient_data',
    expected:Boolean(expected),
    sample_count:sampleCount,
    failure_count:failureCount,
    last_success_at:latestHealthTimestamp(
      (Array.isArray(usageRows) ? usageRows : []).map(row => ({ ...row, last_request_at:row.last_success_at })),
      usages,
    ),
    last_request_at:latestHealthTimestamp(usageRows, usages),
  }
}

function promoteHealthComponent(component, state) {
  if (HEALTH_STATE_RANK[state] > HEALTH_STATE_RANK[component.state]) component.state = state
}

function reviewQueueCount(reviewHealth, statuses) {
  const caseCount = (reviewHealth?.cases || [])
    .filter(row => statuses.includes(String(row?.status || '')))
    .reduce((sum, row) => sum + number(row?.case_count), 0)
  const jobCount = (reviewHealth?.jobs || [])
    .filter(row => statuses.includes(String(row?.status || '')))
    .reduce((sum, row) => sum + number(row?.job_count), 0)
  return caseCount + jobCount
}

export function deriveAdminAiHealth(input = {}) {
  const usageRows = Array.isArray(input.usageRows) ? input.usageRows : []
  const schedulerExpected = number(input.schedulerConfiguredCount) > 0
  const modelCompareExpected = number(input.modelCompareActiveJobs) > 0
  const reviewExpected = reviewQueueCount(input.reviewHealth, ['draft', 'edited', 'ready', 'generating', 'queued', 'leased', 'retry_wait', 'status_unknown']) > 0
  const memoryExpected = (input.rollout?.metrics?.compression_queue || [])
    .some(row => ['queued', 'leased', 'retry_wait', 'status_unknown'].includes(String(row?.status || '')) && number(row?.count) > 0)
  const activeChannels = (input.observer?.channels || []).filter(channel => String(channel?.status || 'active') === 'active')
  const sourceById = new Map((input.observer?.sources || []).map(source => [number(source?.id), source]))
  const unavailableChannels = activeChannels.filter(channel => {
    const source = sourceById.get(number(channel?.source_id))
    return !source || String(source.status || 'active') !== 'active' || !source.bridge_online
  })

  const components = {
    manual:healthComponent(usageRows, HEALTH_USAGE_GROUPS.manual, false),
    model_compare:healthComponent(usageRows, HEALTH_USAGE_GROUPS.model_compare, modelCompareExpected),
    auto_inference:healthComponent(usageRows, HEALTH_USAGE_GROUPS.auto_inference, schedulerExpected),
    review:healthComponent(usageRows, HEALTH_USAGE_GROUPS.review, reviewExpected),
    memory:healthComponent(usageRows, HEALTH_USAGE_GROUPS.memory, memoryExpected),
    observer_delivery:{
      state:activeChannels.length === 0 ? 'insufficient_data' : unavailableChannels.length ? 'critical' : 'healthy',
      expected:activeChannels.length > 0,
      sample_count:activeChannels.length,
      failure_count:unavailableChannels.length,
      last_success_at:null,
      last_request_at:null,
    },
  }
  const reasons = []
  const addReason = (code, severity, value, component) => {
    reasons.push({ code, severity, value:number(value), component })
    if (components[component]) promoteHealthComponent(components[component], severity)
  }

  if (schedulerExpected && !input.schedulerRuntimeAvailable) addReason('scheduler_runtime_unavailable', 'critical', input.schedulerConfiguredCount, 'auto_inference')
  if (number(input.signalErrors24h) > 0) addReason('signal_errors_24h', 'attention', input.signalErrors24h, 'auto_inference')
  if (unavailableChannels.length > 0) addReason('observer_source_unavailable', 'critical', unavailableChannels.length, 'observer_delivery')

  const failedReviews = reviewQueueCount(input.reviewHealth, ['failed'])
  if (failedReviews > 0) addReason('review_jobs_failed', 'attention', failedReviews, 'review')

  for (const alert of Array.isArray(input.rollout?.alerts) ? input.rollout.alerts : []) {
    const severity = alert?.severity === 'critical' ? 'critical' : 'attention'
    const component = alert?.code === 'review_jobs_failed'
      ? 'review'
      : alert?.code === 'memory_compression_stale' ? 'memory' : 'auto_inference'
    if (!reasons.some(reason => reason.code === alert?.code && reason.component === component)) {
      addReason(String(alert?.code || 'governance_alert'), severity, alert?.value, component)
    }
  }

  for (const [component, value] of Object.entries(components)) {
    if (value.failure_count > 0 && !reasons.some(reason => reason.component === component)) {
      addReason('model_requests_failed', 'attention', value.failure_count, component)
    }
  }

  const relevantComponents = Object.values(components).filter(component => component.expected
    || ['attention', 'critical'].includes(component.state))
  const state = relevantComponents.length
    ? relevantComponents.reduce((worst, component) => HEALTH_STATE_RANK[component.state] > HEALTH_STATE_RANK[worst] ? component.state : worst, 'healthy')
    : 'insufficient_data'
  const lastModelRequestMs = usageRows.map(row => parseUtcMs(row?.last_request_at)).filter(value => value !== null)
  const schedulerStateMs = (input.schedulerRuntime || []).map(row => parseUtcMs(row?.state_updated_at_utc)).filter(value => value !== null)
  const lastSignalMs = parseUtcMs(input.lastSignalAt)

  return {
    state,
    headline_code:reasons[0]?.code || (state === 'healthy' ? 'all_expected_components_healthy' : 'no_runtime_expectation'),
    evaluated_at:new Date(number(input.nowMs) || Date.now()).toISOString(),
    window:'24h',
    sample_count:Object.values(components).reduce((sum, component) => sum + number(component.sample_count), 0),
    components,
    freshness:{
      last_model_request_at:lastModelRequestMs.length ? new Date(Math.max(...lastModelRequestMs)).toISOString() : null,
      last_signal_at:lastSignalMs !== null ? new Date(lastSignalMs).toISOString() : null,
      last_scheduler_state_at:schedulerStateMs.length ? new Date(Math.max(...schedulerStateMs)).toISOString() : null,
    },
    reasons:reasons.sort((left, right) => HEALTH_STATE_RANK[right.severity] - HEALTH_STATE_RANK[left.severity]),
  }
}

function runtimeNextRun(state, cooldownTtl, nowMs = Date.now()) {
  const waitReason = String(state?.wait_reason || '')
  const cooldownWait = ['cooldown', 'cooldown_recovered'].includes(waitReason)
  const cooldownTtlKnown = cooldownTtl !== null && cooldownTtl !== undefined
    && Number.isFinite(Number(cooldownTtl))
  if (cooldownWait && cooldownTtlKnown) {
    const seconds = Math.max(0, Number(cooldownTtl))
    return {
      seconds,
      atUtc:seconds > 0 ? new Date(nowMs + seconds * 1000).toISOString() : '',
    }
  }
  const atMs = parseUtcMs(state?.next_run_at_utc)
  if (atMs !== null) {
    return {
      seconds:Math.max(0, Math.ceil((atMs - nowMs) / 1000)),
      atUtc:new Date(atMs).toISOString(),
    }
  }
  const legacySeconds = Math.max(0, number(state?.next_run_in_seconds))
  return {
    seconds:legacySeconds,
    atUtc:legacySeconds > 0 ? new Date(nowMs + legacySeconds * 1000).toISOString() : '',
  }
}

function parseSchedulerSymbols(value) {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string' || !value.trim()) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function schedulerRuntimeCandidates(dbRows, indexedKeys) {
  const candidates = new Set((Array.isArray(indexedKeys) ? indexedKeys : [])
    .map(key => String(key || '').trim()).filter(Boolean))
  for (const row of Array.isArray(dbRows) ? dbRows : []) {
    const strategyId = Number(row?.strategy_id)
    if (!Number.isFinite(strategyId) || strategyId <= 0) continue
    for (const symbol of parseSchedulerSymbols(row?.symbols_json)) {
      const normalized = stripBrokerSuffix(symbol)
      if (normalized) candidates.add(`${strategyId}:${normalized}`)
    }
  }
  return [...candidates]
}

export async function readSchedulerRuntime(dbRows) {
  const redis = getRedis()
  if (!redis || !isRedisAvailable()) return { available:false, schedulers:[] }
  try {
    const configuredRows = Array.isArray(dbRows) ? dbRows : []
    // The key set is an index and can be lost independently of the runtime
    // hashes during a Redis restart.  Derive candidates from active strategy
    // configuration as a read-only fallback so the admin view still exposes
    // the state hash until the scheduler repair path recreates the index.
    const indexedKeys = await redis.smembers('auto:scheduler:keys')
    const keys = schedulerRuntimeCandidates(configuredRows, indexedKeys)
    const schedulers = []
    for (const key of keys) {
      const state = await redis.hgetall(`auto:scheduler:${key}:state`)
      if (!state || !Object.keys(state).length) continue
      const separator = key.indexOf(':')
      const strategyId = Number(separator >= 0 ? key.slice(0, separator) : key)
      const symbol = separator >= 0 ? key.slice(separator + 1) : ''
      const dbInfo = configuredRows.find(row => Number(row.strategy_id) === strategyId)
      let subscriberCount = 0
      try {
        subscriberCount = number(await redis.scard(`auto:scheduler:${key}:subs`))
      } catch {}
      if (subscriberCount <= 0) subscriberCount = number(state.subscriber_count)
      let cooldownTtl = null
      if (['cooldown', 'cooldown_recovered'].includes(String(state.wait_reason || ''))) {
        try { cooldownTtl = Number(await redis.ttl(`auto:scheduler:cooldown:${key}`)) } catch {}
      }
      const nextRun = runtimeNextRun(state, cooldownTtl)
      schedulers.push({
        key,
        strategy_id:strategyId,
        strategy_name:dbInfo?.strategy_name || '',
        symbol,
        running:state.running === '1',
        in_flight:state.in_flight === '1',
        wait_reason:state.wait_reason || '',
        last_error:state.last_error || '',
        market_reason:state.market_reason || '',
        stage:state.stage || 'idle',
        stage_label:state.stage_label || '',
        progress_percent:number(state.progress_percent),
        progress_seq:number(state.progress_seq),
        schedule_mode:state.schedule_mode || 'completion_interval',
        schedule_interval_minutes:number(state.schedule_interval_minutes || state.interval_minutes || dbInfo?.interval_minutes || 5),
        current_slot_id:state.current_slot_id || '',
        current_slot_boundary_utc:state.current_slot_boundary_utc || '',
        current_slot_boundary_terminal:state.current_slot_boundary_terminal || '',
        next_run_at_terminal:state.next_run_at_terminal || '',
        slot_start_lag_ms:number(state.slot_start_lag_ms),
        last_skipped_slot_id:state.last_skipped_slot_id || '',
        last_skipped_slot_reason:state.last_skipped_slot_reason || '',
        skipped_slot_count:number(state.skipped_slot_count),
        interval_minutes:number(state.interval_minutes || dbInfo?.interval_minutes || 5),
        subscriber_count:subscriberCount,
        next_run_in_seconds:nextRun.seconds,
        next_run_at_utc:nextRun.atUtc,
        state_updated_at_utc:state.state_updated_at_utc || null,
        last_run_at:state.last_run_at || null,
      })
    }
    return { available:true, schedulers }
  } catch (error) {
    console.error('[AdminAiOperations] scheduler runtime read failed:', error)
    return { available:false, schedulers:[], error:'scheduler_runtime_unavailable' }
  }
}

export async function getAdminAiOperationsOverview() {
  const bridgeStats = getConnectedBridgeStats()
  const [summary, healthSummary, healthUsage, modelCompareState, modelUsage, schedulerRows, rollout, reviewHealth, sources, channels] = await Promise.all([
    queryOne(`SELECT
      (SELECT COUNT(*) FROM ai_signals WHERE created_at >= CURDATE()) AS signals_today,
      (SELECT COUNT(*) FROM ai_signals WHERE created_at >= CURDATE() AND signal_type = 'error') AS signal_errors_today,
      (SELECT COUNT(*) FROM ai_model_usage_logs WHERE created_at >= CURDATE()
        AND request_status IN ('success','error')) AS model_requests_today,
      (SELECT COUNT(*) FROM ai_model_usage_logs WHERE created_at >= CURDATE()
        AND request_status = 'error') AS model_failures_today,
      (SELECT COALESCE(SUM(token_count), 0) FROM ai_model_usage_logs WHERE created_at >= CURDATE()
        AND request_status IN ('success','error')) AS tokens_today,
      (SELECT ROUND(AVG(duration_ms)) FROM ai_model_usage_logs WHERE created_at >= CURDATE()
        AND request_status = 'success') AS avg_model_latency_ms,
      (SELECT COUNT(*) FROM risk_decisions WHERE created_at >= CURDATE()
        AND decision_status = 'reject') AS risk_rejections_today`),
    queryOne(`SELECT
      (SELECT COUNT(*) FROM ai_signals WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
        AND signal_type = 'error') AS signal_errors_24h,
      (SELECT MAX(created_at) FROM ai_signals WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)) AS last_signal_at`),
    queryAll(`SELECT \`usage\`, COUNT(*) AS request_count,
      SUM(request_status = 'error') AS failure_count,
      MAX(created_at) AS last_request_at,
      MAX(CASE WHEN request_status = 'success' THEN created_at END) AS last_success_at
      FROM ai_model_usage_logs
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
        AND request_status IN ('success','error')
      GROUP BY \`usage\``),
    queryOne(`SELECT COUNT(*) AS active_jobs FROM ai_model_compare_jobs
      WHERE status IN ('queued','running','cancelling','status_unknown')`),
    queryAll(`SELECT COALESCE(profiles.model_name, usage_logs.credential_source) AS model_name,
      usage_logs.credential_source, COUNT(*) AS requests,
      SUM(usage_logs.request_status = 'error') AS failures,
      COALESCE(SUM(usage_logs.token_count), 0) AS tokens,
      COALESCE(ROUND(AVG(CASE WHEN usage_logs.request_status = 'success' THEN usage_logs.duration_ms END)), 0) AS avg_latency_ms
      FROM ai_model_usage_logs usage_logs
      LEFT JOIN ai_model_profiles profiles ON profiles.id = usage_logs.model_profile_id
      WHERE usage_logs.created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
        AND usage_logs.request_status IN ('success','error')
      GROUP BY usage_logs.model_profile_id, profiles.model_name, usage_logs.credential_source
      ORDER BY requests DESC LIMIT 20`),
    queryAll(`SELECT scheduler.prompt_type_id AS strategy_id, strategy.title AS strategy_name,
      strategy.symbols_json, strategy.interval_minutes,
      COUNT(DISTINCT scheduler.user_id) AS subscriber_count
      FROM auto_scheduler scheduler
      JOIN auto_prompt_types strategy ON strategy.id = scheduler.prompt_type_id
      WHERE scheduler.enabled = 1 AND strategy.is_active = 1 AND strategy.deleted_at IS NULL
      GROUP BY scheduler.prompt_type_id, strategy.title, strategy.symbols_json, strategy.interval_minutes
      ORDER BY subscriber_count DESC`),
    getAiRolloutHealth(),
    getReviewAdminHealth(),
    listObserverSources(),
    listObserverChannels(),
  ])
  const runtime = await readSchedulerRuntime(schedulerRows)
  const observer = {
    sources:sources.map(source => ({ ...source, bridge_online:isBridgeAlive(Number(source.bridge_user_id)) })),
    channels,
  }
  const health = deriveAdminAiHealth({
    usageRows:healthUsage,
    signalErrors24h:healthSummary?.signal_errors_24h,
    lastSignalAt:healthSummary?.last_signal_at,
    schedulerRuntimeAvailable:runtime.available,
    schedulerRuntime:runtime.schedulers,
    schedulerConfiguredCount:schedulerRows.length,
    modelCompareActiveJobs:modelCompareState?.active_jobs,
    rollout,
    reviewHealth,
    observer,
  })
  return {
    generated_at:new Date().toISOString(),
    health,
    health_metrics:{
      window:'24h',
      signal_errors_24h:number(healthSummary?.signal_errors_24h),
      usage:(healthUsage || []).map(row => ({
        usage:String(row.usage || ''),
        request_count:number(row.request_count),
        failure_count:number(row.failure_count),
        last_request_at:row.last_request_at || null,
        last_success_at:row.last_success_at || null,
      })),
    },
    mt5_clock:getLatestBridgeMt5Clock(),
    summary:{
      ...Object.fromEntries(Object.entries(summary || {}).map(([key, value]) => [key, number(value)])),
      connected_bridges:bridgeStats.total,
      connected_mt4_bridges:bridgeStats.mt4,
      connected_mt5_bridges:bridgeStats.mt5,
    },
    model_usage:modelUsage.map(row => ({ ...row, requests:number(row.requests), failures:number(row.failures), tokens:number(row.tokens), avg_latency_ms:number(row.avg_latency_ms) })),
    scheduler:{ runtime_available:runtime.available, runtime:runtime.schedulers, configured:schedulerRows.map(row => ({ ...row, strategy_id:number(row.strategy_id), subscriber_count:number(row.subscriber_count), interval_minutes:number(row.interval_minutes) })) },
    rollout,
    review_health:reviewHealth,
    observer,
  }
}
