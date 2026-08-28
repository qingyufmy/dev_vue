/*
 * Build historical model inputs using the same neutral market, Chan and
 * declared-indicator code as the application.  It has no database, bridge,
 * account or network path: all input is the frozen JSON file produced by
 * fetch_mt5_data.py.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { calculateMarketData } from '../../../../server/routes/ai/market-data.js'
import { compactRates } from '../../../../server/routes/ai/utils.js'
import { getChanWindowPolicy, CHAN_WINDOW_POLICY_VERSION } from '../../../../server/routes/ai/chan-window-policy.js'
import { parseStrategyPolicy, prepareStrategyDataRuntime } from '../../../../server/routes/ai/strategy-policy.js'
import { indicatorRequiredHistory } from '../../../../server/routes/ai/indicator-registry.js'
import { projectStrategyContextChanForModel } from '../../../../server/routes/ai/chan-model-payload.js'
import { compactInferenceMarketPayload } from '../../../../server/routes/ai/llm.js'

const TIMEFRAME_MINUTES = { M1:1, M5:5, M15:15, M30:30, H1:60, H4:240, D1:1440, W1:10080 }
const SHA256_PATTERN = /^[a-f0-9]{64}$/i
const REPLAY_SOURCE_ID_BASE = 1_000_000_000_000_000
const REPLAY_SOURCE_IDENTITY_MODE = 'historical_replay_synthetic'

function argValue(args, name, fallback = null) {
  const index = args.indexOf(name)
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback
}

function repeatedArgValues(args, name) {
  const values = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && index + 1 < args.length) values.push(args[index + 1])
  }
  return values
}

function parseDecisionMs(value) {
  if (/^\d+$/.test(String(value || ''))) {
    const numeric = Number(value)
    return numeric < 1e12 ? numeric * 1000 : numeric
  }
  const parsed = Date.parse(String(value || ''))
  if (!Number.isFinite(parsed)) throw new Error('decision_time_invalid')
  return parsed
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')
}

function normalizeSha256(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return SHA256_PATTERN.test(normalized) ? normalized : null
}

/**
 * Return only stable, market-data-bearing fields for the fallback identity.
 * Capture/clock metadata is intentionally excluded because it can vary when
 * the same frozen dataset is copied or replayed on another machine.
 */
function stableDatasetIdentity(marketData = {}) {
  const timeframes = Object.fromEntries(Object.entries(marketData.timeframes || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([timeframe, frame]) => [timeframe, {
      timeframe:frame?.timeframe || timeframe,
      minutes:Number(frame?.minutes) || null,
      bars:(frame?.bars || frame?.klines || []).map(bar => ({
        time:bar?.time ?? null,
        time_utc_msc:bar?.time_utc_msc ?? null,
        time_server_msc:bar?.time_server_msc ?? null,
        open:bar?.open ?? null,
        high:bar?.high ?? null,
        low:bar?.low ?? null,
        close:bar?.close ?? null,
        tick_volume:bar?.tick_volume ?? null,
        spread:bar?.spread ?? null,
      })),
    }]))
  return {
    schema_version:marketData.schema_version || null,
    symbol:marketData.symbol || null,
    standard_symbol:marketData.standard_symbol || null,
    timeframes,
  }
}

function replayDatasetHash(marketData = {}) {
  const frozenHash = normalizeSha256(marketData.market_data_sha256)
  if (frozenHash) return { value:frozenHash, source:'market_data_sha256' }
  const fileHash = normalizeSha256(marketData.market_data_file_sha256)
  if (fileHash) return { value:fileHash, source:'market_data_file_sha256' }
  return { value:hash(stableDatasetIdentity(marketData)), source:'stable_dataset_identity' }
}

/**
 * Build an identity that cannot be mistaken for a production MT source.
 * The large numeric namespace remains a positive safe integer for the
 * production Chan validator, while source_key/mode make the synthetic origin
 * explicit in audit output.
 */
export function buildReplaySourceIdentity(marketData = {}) {
  const dataset = replayDatasetHash(marketData)
  const identityDigest = crypto.createHash('sha256')
    .update(`${REPLAY_SOURCE_IDENTITY_MODE}|${dataset.value}`, 'utf8').digest('hex')
  // Thirteen hexadecimal digits fit below Number.MAX_SAFE_INTEGER even after
  // adding the reserved namespace base, avoiding an unnecessary small modulo
  // space and making accidental cross-dataset ID collisions less likely.
  const digestPrefix = Number.parseInt(identityDigest.slice(0, 13), 16)
  const sourceId = REPLAY_SOURCE_ID_BASE + digestPrefix
  return {
    source_id:sourceId,
    source_key:`${REPLAY_SOURCE_IDENTITY_MODE}|${dataset.source}:${dataset.value}`,
    source_identity_mode:REPLAY_SOURCE_IDENTITY_MODE,
    dataset_hash:dataset.value,
    dataset_hash_source:dataset.source,
  }
}

function localCommit(repoRoot) {
  try {
    const result = spawnSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding:'utf8', stdio:['ignore','pipe','ignore'] })
    const value = String(result.stdout || '').trim()
    return result.status === 0 && /^[0-9a-f]{40}$/i.test(value) ? value : null
  } catch { return null }
}

function parseJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function number(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function openUtcMs(bar) {
  const value = number(bar?.time_utc_msc ?? bar?.time_utc ?? bar?.time_msc)
  if (value == null || value <= 0) return null
  return value < 1e12 ? value * 1000 : value
}

function closedBars(frame, timeframe, decisionMs) {
  const interval = TIMEFRAME_MINUTES[timeframe] * 60_000
  return (frame?.bars || frame?.klines || [])
    .filter(bar => {
      const opened = openUtcMs(bar)
      return opened != null && opened + interval <= decisionMs
    })
    // The frozen source was collected at the end of the seven-day window.
    // Rebase collection metadata to the historical decision boundary so the
    // model cannot infer that this is a later replay from captured_at alone.
    .map(bar => ({ ...bar, captured_at_utc_msc:decisionMs }))
    .sort((left, right) => openUtcMs(left) - openUtcMs(right))
}

function strategyFromMetadata(metadata) {
  const stored = metadata.strategy && typeof metadata.strategy === 'object' ? metadata.strategy : {}
  const policy = metadata.policy && typeof metadata.policy === 'object' ? metadata.policy : {}
  return {
    ...stored,
    system_prompt:'',
    market_data_plan_json:stored.market_data_plan_json ?? JSON.stringify(policy.market_data_plan || {}),
    strategy_policy_json:stored.strategy_policy_json ?? (policy.strategy_policy == null ? null : JSON.stringify(policy.strategy_policy)),
    entry_methods_json:stored.entry_methods_json ?? JSON.stringify(policy.entry_methods || []),
    use_chan_analysis:stored.use_chan_analysis ?? policy.use_chan_analysis,
    use_ema34_filter:stored.use_ema34_filter ?? policy.use_ema34_filter,
  }
}

export function dataQuality(marketData, decisionMs, timeframe, frame, sourceIdentity = buildReplaySourceIdentity(marketData)) {
  const offset = Number(marketData.clock?.broker_offset_seconds)
  return {
    source:'local_mt5',
    platform:'MT5',
    clock_status:'verified',
    timezone_offset_minutes:Number.isFinite(offset) ? offset / 60 : null,
    last_bar_closed:true,
    cache_internal_gap_unresolved:false,
    source_id:sourceIdentity.source_id,
    source_key:sourceIdentity.source_key,
    source_identity_mode:sourceIdentity.source_identity_mode,
    reference_time_utc_msc:decisionMs,
    timeframe,
    bar_count:Array.isArray(frame?.bars) ? frame.bars.length : 0,
  }
}

export function buildPolicySource(timeframe, bars, decisionMs, sourceIdentity, staleToleranceMs) {
  return {
    bars,
    lastBarClosed:true,
    internalGapUnresolved:false,
    marketSource:'local_mt5',
    sourceId:sourceIdentity.source_id,
    sourceKey:sourceIdentity.source_key,
    sourceIdentityMode:sourceIdentity.source_identity_mode,
    // Keep snake-case aliases in the private map so this replay artifact is
    // easy to inspect independently of the runtime's camel-case adapter.
    source_id:sourceIdentity.source_id,
    source_key:sourceIdentity.source_key,
    source_identity_mode:sourceIdentity.source_identity_mode,
    referenceTimeUtcMs:decisionMs,
    staleToleranceMs,
  }
}

function slimSummary(summary, decisionMs) {
  const {
    account: _account,
    positions: _positions,
    symbol: _symbol,
    timeframe: _timeframe,
    timestamp: _timestamp,
    ...slim
  } = summary
  // calculateMarketData's timestamp is a live wall-clock value.  Historical
  // replay must be reproducible, so the frozen decision time is the only
  // timestamp exposed in this experiment.
  slim.last_closed_bar = slim.last_closed_bar || null
  return slim
}

export function buildOneSnapshot({ metadata, marketData, decisionMs, sourceIdentity = buildReplaySourceIdentity(marketData) }) {
  const strategy = strategyFromMetadata(metadata)
  const policy = parseStrategyPolicy(strategy)
  if (String(metadata.chan_window_policy_version || '') !== CHAN_WINDOW_POLICY_VERSION) {
    throw new Error('chan_policy_version_mismatch')
  }
  const planItems = policy.marketDataPlan.timeframes || []
  const allFrames = marketData.timeframes || {}
  const timeframes = {}
  const policySources = {}
  const missing = []
  const sourceByTimeframe = {}
  for (const item of planItems) {
    const timeframe = String(item.timeframe || '').toUpperCase()
    const requestedCount = Math.max(10, Number(item.kline_count) || 100)
    const sourceFrame = allFrames[timeframe]
    if (!sourceFrame) {
      missing.push(timeframe)
      continue
    }
    const closed = closedBars(sourceFrame, timeframe, decisionMs)
    const chanPolicy = policy.useChanAnalysis ? getChanWindowPolicy(timeframe) : null
    const chanEnabled = Boolean(policy.useChanAnalysis && chanPolicy?.supported !== false)
    const indicatorHistory = Math.max(0, ...(policy.compiledPolicy?.indicators || [])
      .filter(definition => definition.enabled && String(definition.source?.timeframe || '').toUpperCase() === timeframe)
      .map(definition => indicatorRequiredHistory(definition)))
    const hiddenCount = Math.max(
      requestedCount,
      chanEnabled ? Number(chanPolicy.target || 0) : 0,
      indicatorHistory,
    )
    const hidden = closed.slice(-hiddenCount)
    const visible = hidden.slice(-requestedCount)
    if (!visible.length) {
      missing.push(timeframe)
      continue
    }
    const quality = dataQuality(marketData, decisionMs, timeframe, sourceFrame, sourceIdentity)
    const summary = calculateMarketData('XAUUSD', timeframe, visible, null, [], {
      computeChan:chanEnabled,
      chanRates:hidden,
      requestedChanHistoryCount:chanEnabled ? chanPolicy.target : null,
      chanMaximumHistoryCount:chanEnabled ? chanPolicy.maximumHistoryCount : null,
      chanValidationWindowCounts:chanEnabled ? chanPolicy.validationWindowCounts : null,
      chanWindowPolicyVersion:chanEnabled ? chanPolicy.windowPolicyVersion : null,
      chanDataQuality:quality,
      pending_orders:[],
    })
    timeframes[timeframe] = {
      summary:slimSummary(summary, decisionMs),
      klines:compactRates(visible),
      ...(policy.useChanAnalysis && chanPolicy?.supported === false
        ? { chan_policy:{ status:'unsupported', reason:chanPolicy.reason, timeframe } }
        : {}),
    }
    const hiddenCompact = compactRates(hidden)
    policySources[timeframe] = buildPolicySource(
      timeframe,
      hiddenCompact,
      decisionMs,
      sourceIdentity,
      Math.max(120_000, TIMEFRAME_MINUTES[timeframe] * 120_000),
    )
    sourceByTimeframe[timeframe] = { hidden_count:hidden.length, visible_count:visible.length, chan_enabled:chanEnabled, indicator_history:indicatorHistory }
  }
  const context = {
    strategy_sequence:planItems.map(item => `${String(item.timeframe).toUpperCase()}(${Number(item.kline_count)})`).join(' → '),
    required_timeframes:planItems.map(item => String(item.timeframe).toUpperCase()),
    used_timeframes:Object.keys(timeframes),
    missing_timeframes:missing,
    context_status:missing.length === 0 ? 'complete' : 'partial',
    timeframes,
  }
  Object.defineProperty(context, 'policyIndicatorSources', { value:policySources, enumerable:false })
  const strategyDataRuntime = prepareStrategyDataRuntime(policy, context, { rawPolicy:policy.strategyPolicy })
  if (strategyDataRuntime) context.indicators = strategyDataRuntime.indicators
  const primary = String(policy.marketDataPlan.primary_timeframe || planItems[0]?.timeframe || '').toUpperCase()
  const primarySummary = timeframes[primary]?.summary || {}
  const market = {
    ...primarySummary,
    symbol:'XAUUSD',
    standard_symbol:'XAUUSD',
    timeframe:primary,
    primary_timeframe:primary,
    timestamp:new Date(decisionMs).toISOString(),
    decision_time_utc:new Date(decisionMs).toISOString(),
    decision_time_utc_msc:decisionMs,
    strategy_context:context,
    requested_timeframes:context.required_timeframes,
    used_timeframes:context.used_timeframes,
    missing_timeframes:context.missing_timeframes,
  }
  for (const [timeframe, frame] of Object.entries(allFrames)) {
    for (const bar of frame.bars || []) {
      const opened = openUtcMs(bar)
      if (opened != null && opened + TIMEFRAME_MINUTES[timeframe] * 60_000 <= decisionMs) continue
      // The entire model market object is checked below.  This branch only
      // documents that source data after the decision is intentionally not
      // copied into the snapshot; future M1 remains in market-data.json for
      // the separate replay stage.
    }
  }
  let futureLeakage = false
  for (const [timeframe, frame] of Object.entries(context.timeframes)) {
    const interval = TIMEFRAME_MINUTES[timeframe] * 60_000
    for (const bar of frame.klines || []) {
      const opened = openUtcMs(bar)
      if (opened != null && opened + interval > decisionMs) futureLeakage = true
    }
  }
  if (futureLeakage) throw new Error('snapshot_future_leakage')
  // Reuse the exact model-bound projections from the live LLM path. The full
  // Chan result remains available in the source context for audit, while the
  // model sees only the fixed Chan structure whitelist and compact K-lines.
  const modelContext = policy.useChanAnalysis
    ? projectStrategyContextChanForModel(context)
    : structuredClone(context)
  delete modelContext.visualization_klines
  const modelMarket = compactInferenceMarketPayload({
    ...market,
    strategy_context:modelContext,
  })
  delete modelMarket.strategy_score
  delete modelMarket.atr_anchor
  delete modelMarket.atr_anchor_tf
  if (modelMarket.strategy_context?.timeframes) {
    for (const frame of Object.values(modelMarket.strategy_context.timeframes)) {
      if (frame?.summary && typeof frame.summary === 'object') delete frame.summary.strategy_score
    }
  }
  return {
    decision_time_utc:new Date(decisionMs).toISOString(),
    decision_time_utc_msc:decisionMs,
    primary_timeframe:primary,
    market:modelMarket,
    market_sha256:hash(modelMarket),
    model_payload_mode:'projectStrategyContextChanForModel+compactInferenceMarketPayload',
    future_leakage:futureLeakage,
    strategy_data_runtime:strategyDataRuntime,
    source_identity:sourceIdentity,
    source_window:{ timeframes:sourceByTimeframe },
  }
}

function main() {
  const args = process.argv.slice(2)
  const marketPath = argValue(args, '--market-data')
  const metadataPath = argValue(args, '--runtime-metadata')
  const outputPath = argValue(args, '--output')
  if (!marketPath || !metadataPath || !outputPath) throw new Error('context_arguments_missing')
  const metadata = parseJsonFile(metadataPath)
  const marketData = parseJsonFile(marketPath)
  const decisionValues = repeatedArgValues(args, '--decision-time')
  if (!decisionValues.length) throw new Error('decision_times_missing')
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
  const localRepoCommit = localCommit(repoRoot)
  if (metadata.source?.git_commit && localRepoCommit
    && String(metadata.source.git_commit).toLowerCase() !== String(localRepoCommit).toLowerCase()) {
    throw new Error('vm_local_commit_mismatch')
  }
  const sourceIdentity = buildReplaySourceIdentity(marketData)
  const snapshots = decisionValues.map(value => buildOneSnapshot({
    metadata,
    marketData,
    decisionMs:parseDecisionMs(value),
    sourceIdentity,
  }))
  const result = {
    schema_version:'strategy-market-snapshots-v1',
    market_data_sha256:marketData.market_data_sha256 || null,
    strategy_body_sha256:metadata.strategy_body_sha256 || null,
    output_schema_sha256:metadata.output_schema_sha256 || null,
    vm_commit:metadata.source?.git_commit || null,
    local_repo_commit:localRepoCommit,
    chan_window_policy_version:CHAN_WINDOW_POLICY_VERSION,
    source_identity:sourceIdentity,
    snapshots,
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive:true })
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
  process.stdout.write(JSON.stringify({ ok:true, snapshot_count:snapshots.length, local_repo_commit:localRepoCommit }))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
    process.exit(0)
  } catch (error) {
    const code = /^[a-z0-9_.:-]+$/i.test(String(error?.message || '')) ? String(error.message) : 'context_build_failed'
    process.stderr.write(code)
    process.exit(1)
  }
}
