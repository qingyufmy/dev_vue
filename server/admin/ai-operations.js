import { queryAll, queryOne } from '../db.js'
import { getRedis, isRedisAvailable } from '../redis.js'
import { getAiRolloutHealth } from '../routes/ai/rollout-governance.js'
import { getReviewAdminHealth } from '../routes/ai/review-workflow.js'
import { listObserverChannels, listObserverSources } from '../routes/ai/observer-channels.js'
import { isBridgeAlive } from '../bridge-ws.js'

function number(value) {
  return Number(value || 0)
}

async function readSchedulerRuntime(dbRows) {
  const redis = getRedis()
  if (!redis || !isRedisAvailable()) return { available:false, schedulers:[] }
  try {
    const keys = await redis.smembers('auto:scheduler:keys')
    const schedulers = []
    for (const key of keys) {
      const state = await redis.hgetall(`auto:scheduler:${key}:state`)
      if (!state || !Object.keys(state).length) continue
      const separator = key.indexOf(':')
      const strategyId = Number(separator >= 0 ? key.slice(0, separator) : key)
      const symbol = separator >= 0 ? key.slice(separator + 1) : ''
      const dbInfo = dbRows.find(row => Number(row.strategy_id) === strategyId)
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
        interval_minutes:number(state.interval_minutes || dbInfo?.interval_minutes || 5),
        subscriber_count:number(await redis.scard(`auto:scheduler:${key}:subs`)),
        next_run_in_seconds:number(state.next_run_in_seconds),
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
  const [summary, modelUsage, schedulerRows, rollout, reviewHealth, sources, channels] = await Promise.all([
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
        AND decision_status = 'reject') AS risk_rejections_today,
      (SELECT COUNT(*) FROM bridge_connection_status WHERE connected = 1
        AND updated_at >= DATE_SUB(NOW(), INTERVAL 90 SECOND)) AS connected_bridges`),
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
  return {
    generated_at:new Date().toISOString(),
    summary:Object.fromEntries(Object.entries(summary || {}).map(([key, value]) => [key, number(value)])),
    model_usage:modelUsage.map(row => ({ ...row, requests:number(row.requests), failures:number(row.failures), tokens:number(row.tokens), avg_latency_ms:number(row.avg_latency_ms) })),
    scheduler:{ runtime_available:runtime.available, runtime:runtime.schedulers, configured:schedulerRows.map(row => ({ ...row, strategy_id:number(row.strategy_id), subscriber_count:number(row.subscriber_count), interval_minutes:number(row.interval_minutes) })) },
    rollout,
    review_health:reviewHealth,
    observer:{
      sources:sources.map(source => ({ ...source, bridge_online:isBridgeAlive(Number(source.bridge_user_id)) })),
      channels,
    },
  }
}
