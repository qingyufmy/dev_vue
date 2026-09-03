import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  isPositionGuardFeatureEnabled,
  positionGuardFeatureGate,
} from '../../server/routes/ai/position-guard-feature.js'

const routes = readFileSync(new URL('../../server/routes/ai/index.js', import.meta.url), 'utf8')
const serverIndex = readFileSync(new URL('../../server/index.js', import.meta.url), 'utf8')
const monitor = readFileSync(new URL('../../server/workers/position-guard-monitor-worker.js', import.meta.url), 'utf8')
const execution = readFileSync(new URL('../../server/routes/ai/position-guard-execution.js', import.meta.url), 'utf8')

describe('deployment-level Position Guard gate', () => {
  it('defaults to disabled and enables only the explicit true value', () => {
    expect(isPositionGuardFeatureEnabled({})).toBe(false)
    expect(isPositionGuardFeatureEnabled({ POSITION_GUARD_FEATURE_ENABLED:'' })).toBe(false)
    expect(isPositionGuardFeatureEnabled({ POSITION_GUARD_FEATURE_ENABLED:'false' })).toBe(false)
    expect(isPositionGuardFeatureEnabled({ POSITION_GUARD_FEATURE_ENABLED:'1' })).toBe(false)
    expect(isPositionGuardFeatureEnabled({ POSITION_GUARD_FEATURE_ENABLED:'yes' })).toBe(false)
    expect(isPositionGuardFeatureEnabled({ POSITION_GUARD_FEATURE_ENABLED:'true' })).toBe(true)
    expect(isPositionGuardFeatureEnabled({ POSITION_GUARD_FEATURE_ENABLED:' TRUE ' })).toBe(true)
  })

  it('returns the stable 404 JSON contract while disabled and reads env dynamically', () => {
    const previous = process.env.POSITION_GUARD_FEATURE_ENABLED
    const next = () => {
      process.env.POSITION_GUARD_FEATURE_ENABLED = 'true'
      return { status:vi.fn().mockReturnThis(), json:vi.fn() }
    }
    try {
      delete process.env.POSITION_GUARD_FEATURE_ENABLED
      const disabledRes = { status:vi.fn().mockReturnThis(), json:vi.fn() }
      const disabledNext = vi.fn()
      positionGuardFeatureGate({}, disabledRes, disabledNext)
      expect(disabledRes.status).toHaveBeenCalledWith(404)
      expect(disabledRes.json).toHaveBeenCalledWith({ ok:false, error:'position_guard_feature_disabled' })
      expect(disabledNext).not.toHaveBeenCalled()

      const enabledRes = next()
      const enabledNext = vi.fn()
      positionGuardFeatureGate({}, enabledRes, enabledNext)
      expect(enabledNext).toHaveBeenCalledOnce()
      expect(enabledRes.status).not.toHaveBeenCalled()
    } finally {
      if (previous === undefined) delete process.env.POSITION_GUARD_FEATURE_ENABLED
      else process.env.POSITION_GUARD_FEATURE_ENABLED = previous
    }
  })

  it('installs one gate for both user and administrator configuration route trees', () => {
    expect(routes).toContain("router.use('/ai/position-guard', positionGuardFeatureGate)")
    expect(routes).toContain("router.use('/ai/admin/position-guard', positionGuardFeatureGate)")
    expect(routes).toContain('feature_enabled:true')
    expect(serverIndex).toContain('if (isPositionGuardFeatureEnabled())')
    expect(serverIndex).toContain('startPositionGuardMonitorWorker()')
  })

  it('guards monitor and execution before any automatic database or Bridge work', () => {
    const runStart = monitor.indexOf('export async function runPositionGuardMonitorOnce')
    const runBody = monitor.slice(runStart, monitor.indexOf('\nfunction runGuarded', runStart))
    expect(runBody.indexOf('isPositionGuardFeatureEnabled')).toBeGreaterThan(-1)
    expect(runBody.indexOf('isPositionGuardFeatureEnabled')).toBeLessThan(runBody.indexOf('workerRunning = true'))
    expect(execution).toContain("if (!isPositionGuardFeatureEnabled()) return false")
    expect(execution).toContain("if (!isPositionGuardFeatureEnabled()) return false\n      task = await markSending")
  })

})
