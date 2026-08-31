import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BROWSER_WS_BANDWIDTH_WINDOW_MS,
  browserWsJsonByteLength,
  createBrowserWsBandwidthMetrics,
  normalizeBrowserWsAction,
} from '../../server/browser-ws-bandwidth-metrics.js'

afterEach(() => {
  vi.restoreAllMocks()
})

function metricLogger() {
  const lines = []
  return {
    lines,
    log: line => lines.push(line),
  }
}

describe('browser WebSocket bandwidth metrics', () => {
  it('is disabled by default and has no observable output', () => {
    const output = metricLogger()
    const metrics = createBrowserWsBandwidthMetrics({ enabled: false, logger: output.log })

    expect(metrics.enabled).toBe(false)
    expect(metrics.record('rates', { requestBytes: 10, responseBytes: 20 })).toBe(false)
    expect(metrics.flush()).toBeNull()
    expect(output.lines).toEqual([])
    metrics.dispose()
  })

  it('normalizes unknown and overlong actions to the fixed other bucket', () => {
    expect(normalizeBrowserWsAction('rates')).toBe('rates')
    expect(normalizeBrowserWsAction('rates-with-token-secret')).toBe('other')
    expect(normalizeBrowserWsAction({ action: 'rates' })).toBe('other')
  })

  it('aggregates requests and responses in a 60 second window with p95 latency', () => {
    let now = 1_000
    const output = metricLogger()
    const metrics = createBrowserWsBandwidthMetrics({
      enabled: true,
      now: () => now,
      logger: output.log,
      maxLatencySamples: 8,
    })

    metrics.record('rates', {
      requestBytes: 17,
      responseBytes: 120,
      status: 'success',
      durationMs: 10,
    })
    now += 1
    metrics.record('rates', {
      requestBytes: 19,
      responseBytes: 240,
      status: 'error',
      durationMs: 40,
    })
    now += 1
    metrics.record('new-client-action-with-payload-token', {
      requestBytes: 1,
      responseBytes: 2,
      status: 'unknown-status',
      durationMs: 20,
    })

    const summary = metrics.flush()
    expect(summary.window_ms).toBe(BROWSER_WS_BANDWIDTH_WINDOW_MS)
    expect(summary.actions.rates).toMatchObject({
      requests: 2,
      responses: 2,
      request_bytes: 36,
      response_bytes: 360,
      max_response_bytes: 240,
      p95_latency_ms: 40,
      status_counts: { error: 1, success: 1 },
    })
    expect(summary.actions.other).toMatchObject({
      requests: 1,
      responses: 1,
      request_bytes: 1,
      response_bytes: 2,
      status_counts: { other: 1 },
    })
    expect(output.lines).toHaveLength(1)
    expect(JSON.parse(output.lines[0])).toEqual(summary)
    expect(output.lines[0]).not.toContain('payload')
    expect(output.lines[0]).not.toContain('token')
    metrics.dispose()
  })

  it('rotates at the window boundary and retains only bounded latency samples', () => {
    let now = 0
    const output = metricLogger()
    const metrics = createBrowserWsBandwidthMetrics({
      enabled: true,
      now: () => now,
      logger: output.log,
      maxLatencySamples: 2,
    })

    metrics.record('health', { responseBytes: 1, durationMs: 5 })
    now = BROWSER_WS_BANDWIDTH_WINDOW_MS
    metrics.record('health', { responseBytes: 2, durationMs: 10 })
    now += 1
    metrics.record('health', { responseBytes: 3, durationMs: 20 })
    const currentSummary = metrics.flush()

    expect(output.lines).toHaveLength(2)
    const firstSummary = JSON.parse(output.lines[0])
    expect(firstSummary.actions.health.responses).toBe(1)
    expect(firstSummary.actions.health.response_bytes).toBe(1)
    expect(currentSummary.actions.health.responses).toBe(2)
    expect(currentSummary.actions.health.response_bytes).toBe(5)
    expect(currentSummary.actions.health.p95_latency_ms).toBeGreaterThanOrEqual(10)
    metrics.dispose()
  })

  it('keeps command completion idempotent and handles serialization failure safely', () => {
    let now = 5_000
    const output = metricLogger()
    const metrics = createBrowserWsBandwidthMetrics({ enabled: true, now: () => now, logger: output.log })
    const command = metrics.begin('account', browserWsJsonByteLength({ type: 'command', action: 'account' }))

    now += 12
    expect(command.finish(33, 'success')).toBe(true)
    expect(command.finish(999, 'error')).toBe(false)
    expect(browserWsJsonByteLength({ token: 'must-not-be-logged', value: 1n })).toBe(0)

    const summary = metrics.flush()
    expect(summary.actions.account).toMatchObject({
      requests: 1,
      responses: 1,
      response_bytes: 33,
      p95_latency_ms: 12,
    })
    expect(output.lines[0]).not.toContain('must-not-be-logged')
    metrics.dispose()
  })

  it('unrefs the aggregation timer when enabled', () => {
    const unref = vi.fn()
    vi.spyOn(globalThis, 'setInterval').mockReturnValue({ unref })
    const metrics = createBrowserWsBandwidthMetrics({ enabled: true, logger: () => {} })

    expect(unref).toHaveBeenCalledOnce()
    metrics.dispose()
  })
})
