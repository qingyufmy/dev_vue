import { getChanWindowPolicy } from './chan-window-policy.js'
import { parseSnapshotJson, sha256 } from './inference-snapshots.js'
import { classifyContinuityGap, MARKET_SESSION_ENGINE_VERSION } from './market-session-calendar.js'

const TIMEFRAMES = ['M5', 'M15', 'H1', 'H4']

function snapshotParts(row = {}) {
  return {
    klines:parseSnapshotJson(row.klines_json ?? row.klines, {}),
    market:parseSnapshotJson(row.market_snapshot_json ?? row.market_snapshot, {}),
    runtime:parseSnapshotJson(row.strategy_runtime_json ?? row.strategy_runtime, null),
  }
}

function frameSummary(market, timeframe) {
  return market?.strategy_context?.timeframes?.[timeframe]?.summary || {}
}

function boundedRows(value) {
  return Array.isArray(value) ? value : []
}

export function buildFrozenChanSnapshotDiagnostics(row = {}) {
  const { klines, market, runtime } = snapshotParts(row)
  const frames = {}
  for (const timeframe of TIMEFRAMES) {
    const summary = frameSummary(market, timeframe)
    const chan = summary.chan || null
    const quality = summary.market_data_quality || null
    const policy = getChanWindowPolicy(timeframe)
    const candles = boundedRows(klines?.[timeframe])
    frames[timeframe] = {
      candle_count:candles.length,
      requested_history_count:Number(chan?.requested_history_count || chan?.source_history_count || 0),
      received_history_count:Number(chan?.received_history_count || chan?.source_history_count || candles.length),
      closed_history_count:Number(chan?.closed_bar_count || 0),
      target_window:policy.target,
      validation_windows:[...policy.validators],
      continuity:chan?.continuity || quality?.continuity || quality || null,
      window_stable:chan?.window_stable ?? null,
      segment_count:Number(chan?.segment_count || 0),
      segment_direction:chan?.trend_state?.direction || chan?.current_segment?.dir || null,
      segment_stable_id:chan?.current_segment?.stable_id || chan?.current_segment?.segment_stable_id || null,
      center_count:Number(chan?.center_count || 0),
      center_core_stable_id:chan?.latest_center?.core_stable_id || chan?.latest_center?.stable_id || null,
      center_entry_segment_stable_id:chan?.latest_center?.entry_segment_stable_id || null,
      cross_window_support_count:Number(chan?.cross_window_support_count || chan?.cross_window_center_support_count || 0),
      cross_window_validator_count:Number(chan?.cross_window_validator_count || 0),
      temporal_closed_bar_support:Number(chan?.temporal_closed_bar_support || 0),
      temporal_identity_stable:chan?.temporal_identity_stable ?? null,
      structure_anchor:chan?.structure_anchor || null,
      evidence_capabilities:chan?.evidence_capabilities || null,
      status:chan?.status || (runtime?.use_chan_analysis === false ? 'disabled' : 'unavailable'),
      reliability:chan?.reliability || null,
      warnings:Array.isArray(chan?.warnings) ? chan.warnings : [],
    }
  }
  const diagnostic = {
    schema_version:'frozen-chan-diagnostic-v1',
    snapshot_id:Number(row.id) || null,
    signal_id:Number(row.signal_id) || null,
    strategy_id:Number(row.strategy_id) || null,
    strategy_version:Number(row.strategy_version) || null,
    standard_symbol:row.standard_symbol || market.standard_symbol || market.symbol || null,
    market_source:row.market_source || market.market_source || null,
    snapshot_content_hash:row.content_hash || null,
    frames,
  }
  return { ...diagnostic, diagnostic_hash:sha256(JSON.stringify(diagnostic)) }
}

export function auditFrozenMarketSessionContinuity(row = {}, options = {}) {
  const { klines, market } = snapshotParts(row)
  const frames = {}
  for (const timeframe of TIMEFRAMES) {
    const summary = frameSummary(market, timeframe)
    const quality = summary.market_data_quality || {}
    const continuity = quality.continuity || {}
    const identity = continuity.source_identity || quality.source_identity || quality
    const rates = boundedRows(klines?.[timeframe]).map(rate => ({
      utc:Number(rate?.time_utc_msc), broker:rate?.time || rate?.broker_time || null,
    })).filter(rate => Number.isFinite(rate.utc)).sort((left, right) => left.utc - right.utc)
    const intervalMs = { M5:300000, M15:900000, H1:3600000, H4:14400000 }[timeframe]
    const gaps = []
    for (let index = 1; index < rates.length; index += 1) {
      if (rates[index].utc - rates[index - 1].utc <= intervalMs) continue
      gaps.push(classifyContinuityGap(rates[index - 1].utc, rates[index].utc, timeframe, {
        intervalMs,
        startBrokerTime:rates[index - 1].broker,
        endBrokerTime:rates[index].broker,
        standardSymbol:row.standard_symbol || market.standard_symbol || market.symbol,
        strictSessionPolicy:true,
        platform:identity.platform,
        brokerServer:identity.broker_server,
        timezoneOffsetMinutes:quality.timezone_offset_minutes,
        clockStatus:quality.clock_status,
        marketSessionPolicyMode:options.mode,
        env:options.env || process.env,
      }))
    }
    frames[timeframe] = {
      candle_count:rates.length,
      status:gaps.some(gap => gap?.known !== true || gap?.expected === false) ? 'suspicious_gap' : 'ok',
      continuity_engine_version:MARKET_SESSION_ENGINE_VERSION,
      gaps,
      frozen_continuity:continuity,
    }
  }
  const audit = {
    schema_version:'frozen-market-session-audit-v1',
    snapshot_id:Number(row.id) || null,
    signal_id:Number(row.signal_id) || null,
    snapshot_content_hash:row.content_hash || null,
    frames,
  }
  return { ...audit, audit_hash:sha256(JSON.stringify(audit)) }
}
