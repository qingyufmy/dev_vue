const METRICS_ENV = 'BROWSER_WS_BANDWIDTH_METRICS'

export const BROWSER_WS_BANDWIDTH_WINDOW_MS = 60_000
export const BROWSER_WS_BANDWIDTH_MAX_LATENCY_SAMPLES = 256

// Keep this list intentionally small and stable.  A client supplied action is
// never written to a metric line; unknown or newly introduced actions collapse
// into `other` so that the log cardinality cannot be used as an input channel.
export const BROWSER_WS_METRIC_ACTIONS = Object.freeze([
  'health',
  'account',
  'symbols',
  'platform_quote',
  'quote',
  'positions',
  'open',
  'close',
  'toggle_trade',
  'set_quote_symbol',
  'history_range_preference_set',
  'history',
  'history_prepare_status_v1',
  'history_chart_data',
  'rates',
  'diagnostics',
  'analyze',
  'compare',
  'signals_latest_id',
  'signal_detail',
  'signal_evidence',
  'signals',
  'execute',
  'auto_status',
  'toggle_auto',
  'audit_logs',
  'signal_tickets',
  'save_close_config',
  'get_close_config',
  'close_status',
  'close_signal_tickets',
  'pending_list',
  'cancel_pending',
  'signal_by_ticket',
  'export_history',
  'toggle_close',
  'run_close_now',
  'admin_dashboard',
  'admin_user_status',
  'admin_user_search',
  'admin_user_list',
  'other',
])

const ACTIONS = new Set(BROWSER_WS_METRIC_ACTIONS)
const METRIC_STATUSES = new Set([
  'success',
  'error',
  'other',
  'not_sent',
  'serialization_error',
  'send_error',
])

function nonNegativeInteger(value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return 0
  return Math.min(Math.floor(number), Number.MAX_SAFE_INTEGER)
}

function metricStatus(value) {
  const status = typeof value === 'string' ? value : ''
  return METRIC_STATUSES.has(status) ? status : 'other'
}

function percentile(values, quantile) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.max(0, Math.ceil(sorted.length * quantile) - 1)
  return sorted[rank]
}

function newBucket() {
  return {
    requests: 0,
    responses: 0,
    requestBytes: 0,
    responseBytes: 0,
    maxResponseBytes: 0,
    latencySamples: [],
    latencySampleCount: 0,
    statusCounts: Object.create(null),
  }
}

function bucketSnapshot(bucket) {
  const statuses = {}
  for (const status of Object.keys(bucket.statusCounts).sort()) {
    statuses[status] = bucket.statusCounts[status]
  }
  return {
    requests: bucket.requests,
    responses: bucket.responses,
    request_bytes: bucket.requestBytes,
    response_bytes: bucket.responseBytes,
    max_response_bytes: bucket.maxResponseBytes,
    p95_latency_ms: percentile(bucket.latencySamples, 0.95),
    status_counts: statuses,
  }
}

function defaultLogger(line) {
  console.log(line)
}

function clockValue(now) {
  try {
    const value = Number(now())
    return Number.isFinite(value) ? value : Date.now()
  } catch {
    return Date.now()
  }
}

export function normalizeBrowserWsAction(action) {
  return typeof action === 'string' && ACTIONS.has(action) ? action : 'other'
}

// This is deliberately a safe, ephemeral conversion.  The serialized value
// is never retained or logged; callers only receive its UTF-8 byte count.
export function browserWsJsonByteLength(value) {
  try {
    const serialized = JSON.stringify(value)
    return typeof serialized === 'string' ? Buffer.byteLength(serialized, 'utf8') : 0
  } catch {
    return 0
  }
}

export function createBrowserWsBandwidthMetrics({
  enabled = process.env[METRICS_ENV] === '1',
  now = () => Date.now(),
  logger = defaultLogger,
  windowMs = BROWSER_WS_BANDWIDTH_WINDOW_MS,
  maxLatencySamples = BROWSER_WS_BANDWIDTH_MAX_LATENCY_SAMPLES,
} = {}) {
  const isEnabled = enabled === true || enabled === '1'
  const safeWindowMs = Number.isFinite(Number(windowMs)) && Number(windowMs) > 0
    ? Math.floor(Number(windowMs)) : BROWSER_WS_BANDWIDTH_WINDOW_MS
  const safeMaxLatencySamples = Number.isFinite(Number(maxLatencySamples))
    ? Math.max(1, Math.floor(Number(maxLatencySamples)))
    : BROWSER_WS_BANDWIDTH_MAX_LATENCY_SAMPLES

  let timer = null
  let windowStartMs = null
  let buckets = new Map()

  const safeNow = () => clockValue(now)

  const emit = summary => {
    if (!summary) return
    try {
      const line = JSON.stringify(summary)
      if (typeof logger === 'function') logger(line)
    } catch {
      // Observability must never affect browser command behavior.
    }
  }

  const ensureWindow = atMs => {
    if (windowStartMs == null) {
      windowStartMs = Math.floor(atMs / safeWindowMs) * safeWindowMs
    }
    if (atMs < windowStartMs) return
    if (atMs >= windowStartMs + safeWindowMs) {
      flushWindow()
      windowStartMs = Math.floor(atMs / safeWindowMs) * safeWindowMs
      buckets = new Map()
    }
  }

  const bucketFor = action => {
    let bucket = buckets.get(action)
    if (!bucket) {
      bucket = newBucket()
      buckets.set(action, bucket)
    }
    return bucket
  }

  function flushWindow() {
    if (!isEnabled || windowStartMs == null || buckets.size === 0) return null
    const actions = {}
    for (const action of BROWSER_WS_METRIC_ACTIONS) {
      const bucket = buckets.get(action)
      if (bucket) actions[action] = bucketSnapshot(bucket)
    }
    const summary = {
      type: 'browser_ws_bandwidth',
      window_ms: safeWindowMs,
      window_start: new Date(windowStartMs).toISOString(),
      window_end: new Date(windowStartMs + safeWindowMs).toISOString(),
      actions,
    }
    buckets = new Map()
    emit(summary)
    return summary
  }

  function rotate(atMs = safeNow()) {
    if (!isEnabled) return null
    ensureWindow(atMs)
    return null
  }

  function addLatency(bucket, durationMs) {
    const duration = nonNegativeInteger(durationMs)
    bucket.latencySampleCount += 1
    if (bucket.latencySamples.length < safeMaxLatencySamples) {
      bucket.latencySamples.push(duration)
      return
    }
    // Reservoir sampling bounds memory while keeping the sample representative
    // when a busy VM receives more than the fixed sample limit in one window.
    const slot = Math.floor(Math.random() * bucket.latencySampleCount)
    if (slot < safeMaxLatencySamples) bucket.latencySamples[slot] = duration
  }

  function recordRequest(action, requestBytes = 0) {
    if (!isEnabled) return false
    try {
      const atMs = safeNow()
      rotate(atMs)
      const bucket = bucketFor(normalizeBrowserWsAction(action))
      bucket.requests += 1
      bucket.requestBytes += nonNegativeInteger(requestBytes)
      return true
    } catch {
      return false
    }
  }

  function recordResponse(action, responseBytes = 0, status = 'other', durationMs = 0) {
    if (!isEnabled) return false
    try {
      const atMs = safeNow()
      rotate(atMs)
      const bucket = bucketFor(normalizeBrowserWsAction(action))
      const bytes = nonNegativeInteger(responseBytes)
      const normalizedStatus = metricStatus(status)
      bucket.responses += 1
      bucket.responseBytes += bytes
      bucket.maxResponseBytes = Math.max(bucket.maxResponseBytes, bytes)
      bucket.statusCounts[normalizedStatus] = (bucket.statusCounts[normalizedStatus] || 0) + 1
      addLatency(bucket, durationMs)
      return true
    } catch {
      return false
    }
  }

  function record(action, {
    requestBytes = 0,
    responseBytes = 0,
    status = 'other',
    durationMs = 0,
  } = {}) {
    if (!isEnabled) return false
    try {
      recordRequest(action, requestBytes)
      recordResponse(action, responseBytes, status, durationMs)
      return true
    } catch {
      return false
    }
  }

  function begin(action, requestBytes = 0) {
    if (!isEnabled) return { finish: () => false }
    const normalizedAction = normalizeBrowserWsAction(action)
    const startedAt = safeNow()
    recordRequest(normalizedAction, requestBytes)
    let finished = false
    return {
      finish(responseBytes = 0, status = 'other', durationMs = null) {
        if (finished) return false
        finished = true
        const duration = durationMs == null ? Math.max(0, safeNow() - startedAt) : durationMs
        return recordResponse(normalizedAction, responseBytes, status, duration)
      },
    }
  }

  function flush() {
    if (!isEnabled) return null
    try {
      return flushWindow()
    } catch {
      return null
    }
  }

  function dispose({ flush: flushBeforeDispose = false } = {}) {
    if (timer) clearInterval(timer)
    timer = null
    if (flushBeforeDispose) flush()
    else buckets = new Map()
  }

  if (isEnabled) {
    try {
      timer = setInterval(() => {
        try { rotate() } catch {}
      }, safeWindowMs)
      timer.unref?.()
    } catch {
      timer = null
    }
  }

  return Object.freeze({
    enabled: isEnabled,
    begin,
    record,
    recordRequest,
    recordResponse,
    flush,
    dispose,
  })
}

export const browserWsBandwidthMetrics = createBrowserWsBandwidthMetrics()
