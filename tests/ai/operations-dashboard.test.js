import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const bridgeWs = readFileSync(new URL('../../server/bridge-ws.js', import.meta.url), 'utf8')
const app = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')
const scheduler = readFileSync(new URL('../../server/routes/ai/scheduler.js', import.meta.url), 'utf8')

describe('operations dashboard data contracts', () => {
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
    expect(app).toContain('schedulerReasonText(s.last_error, true)')
    expect(app).toContain('schedulerReasonText(s.market_reason)')
    expect(app).toContain("lock_busy: '上一轮分析仍在结束，正在等待调度权'")
    expect(app).not.toContain("escapeHtml(s.last_error) + '</p>'")
  })

  it('treats a held lock as a wait state and shortens abandoned leases', () => {
    expect(scheduler).toContain('const LOCK_TTL_MS = 120000')
    expect(scheduler).toContain("st.waitReason = 'lock_busy'")
    expect(scheduler).toContain("st.lastError = ''")
    expect(scheduler).toContain('await updateSchedulerRedisState(key, st)')
    expect(scheduler).not.toContain("st.lastError = 'redis_lock_failed'")
  })
})
