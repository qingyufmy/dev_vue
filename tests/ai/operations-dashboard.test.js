import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const bridgeWs = readFileSync(new URL('../../server/bridge-ws.js', import.meta.url), 'utf8')
const adminApp = readFileSync(new URL('../../public/admin/app.js', import.meta.url), 'utf8')
const scheduler = readFileSync(new URL('../../server/routes/ai/scheduler.js', import.meta.url), 'utf8')
const aiOperations = readFileSync(new URL('../../server/admin/ai-operations.js', import.meta.url), 'utf8')

describe('operations dashboard data contracts', () => {
  it('counts live MT4 and MT5 terminals instead of legacy user status rows', () => {
    expect(aiOperations).toContain('getConnectedBridgeStats()')
    expect(aiOperations).toContain('connected_mt4_bridges:bridgeStats.mt4')
    expect(aiOperations).toContain('connected_mt5_bridges:bridgeStats.mt5')
    expect(aiOperations).not.toContain('FROM bridge_connection_status WHERE connected = 1')
    expect(adminApp).toContain('MT4 ${connectedMt4Bridges} · MT5 ${connectedMt5Bridges}')
  })

  it('counts only the canonical actionable period review', () => {
    expect(bridgeWs).toContain("review_case.status IN ('draft', 'edited')")
    expect(bridgeWs).toContain("ORDER BY (candidate.status = 'approved') DESC, candidate.id DESC LIMIT 1")
    expect(bridgeWs).not.toContain("SELECT COUNT(*) FROM period_review_cases WHERE status IN ('draft', 'edited')")
  })

  it('uses completed model calls as the usage source of truth', () => {
    expect(bridgeWs).toContain("request_status IN ('success', 'error')")
    expect(bridgeWs).toContain("request_status = 'error') AS model_failures_today")
    expect(bridgeWs).toContain('FROM ai_model_usage_logs')
    expect(bridgeWs).toContain('COALESCE(request_bytes, 0) + COALESCE(response_bytes, 0)')
  })

  it('counts a signal executed when one of its deliveries executed', () => {
    expect(bridgeWs).toContain('deliveries.signal_id = signals.id AND deliveries.is_executed = 1')
  })
})

describe('operations scheduler presentation', () => {
  it('localizes scheduler details instead of exposing raw internal text', () => {
    expect(adminApp).toContain('schedulerReason(item.last_error, true)')
    expect(adminApp).toContain('schedulerReason(item.wait_reason)')
    expect(adminApp).toContain("lock_busy:'等待上一轮调度结束'")
    expect(adminApp).not.toContain('escapeHtml(item.last_error)')
  })

  it('treats a held lock as a wait state and shortens abandoned leases', () => {
    expect(scheduler).toContain('const LOCK_TTL_MS = 120000')
    expect(scheduler).toContain("st.waitReason = 'lock_busy'")
    expect(scheduler).toContain("st.lastError = ''")
    expect(scheduler).toContain('await updateSchedulerRedisState(key, st)')
    expect(scheduler).not.toContain("st.lastError = 'redis_lock_failed'")
  })
})
