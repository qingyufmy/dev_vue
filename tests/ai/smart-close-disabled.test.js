import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const scheduler = readFileSync(new URL('../../server/routes/ai/scheduler.js', import.meta.url), 'utf8')
const bridge = readFileSync(new URL('../../server/bridge-ws.js', import.meta.url), 'utf8')
const migrations = readFileSync(new URL('../../server/migrations.js', import.meta.url), 'utf8')

describe('disabled smart-close runtime', () => {
  it('does not keep retired scheduler state or callable stubs', () => {
    expect(scheduler).not.toContain('SMART_CLOSE_FEATURE_ENABLED')
    expect(scheduler).not.toContain('closeSchedulerState')
    expect(scheduler).not.toContain('startSmartCloseScheduler')
    expect(scheduler).not.toContain('stopSmartCloseScheduler')
    expect(scheduler).not.toContain('runSmartCloseCycle')
    expect(scheduler).not.toContain('function runSmartClose(')
    expect(scheduler).not.toContain('function runCloseRules(')
    expect(scheduler).not.toContain("session_id, 'smart_close'")
  })

  it('rejects every legacy WebSocket mutation entry point', () => {
    for (const action of ['save_close_config', 'toggle_close', 'run_close_now']) {
      const start = bridge.indexOf(`case '${action}'`)
      expect(start).toBeGreaterThan(-1)
      expect(bridge.slice(start, start + 320)).toContain("code:'smart_close_feature_retired'")
    }
    expect(bridge).not.toContain('ai.runSmartCloseCycle(userId)')
    expect(bridge).not.toContain('ai.startSmartCloseScheduler(userId)')
  })

  it('clears previously enabled database configurations', () => {
    expect(migrations).toContain("id: '106_disable_smart_close_runtime'")
    expect(migrations).toContain('UPDATE close_config SET enabled = 0 WHERE enabled <> 0')
  })
})
