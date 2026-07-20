import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const scheduler = readFileSync(new URL('../../server/routes/ai/scheduler.js', import.meta.url), 'utf8')
const bridge = readFileSync(new URL('../../server/bridge-ws.js', import.meta.url), 'utf8')
const migrations = readFileSync(new URL('../../server/migrations.js', import.meta.url), 'utf8')

describe('disabled smart-close runtime', () => {
  it('fails closed in both scheduler entry points', () => {
    expect(scheduler).toContain('export const SMART_CLOSE_FEATURE_ENABLED = false')
    expect(scheduler).toMatch(/startSmartCloseScheduler[\s\S]*if \(!SMART_CLOSE_FEATURE_ENABLED\) return false/)
    expect(scheduler).toMatch(/runSmartCloseCycle[\s\S]*if \(!SMART_CLOSE_FEATURE_ENABLED\) throw new Error\('smart_close_feature_disabled'\)/)
  })

  it('rejects every legacy WebSocket mutation entry point', () => {
    for (const action of ['save_close_config', 'toggle_close', 'run_close_now']) {
      const start = bridge.indexOf(`case '${action}'`)
      expect(start).toBeGreaterThan(-1)
      expect(bridge.slice(start, start + 260)).toContain('if (!ai.SMART_CLOSE_FEATURE_ENABLED)')
    }
  })

  it('clears previously enabled database configurations', () => {
    expect(migrations).toContain("id: '106_disable_smart_close_runtime'")
    expect(migrations).toContain('UPDATE close_config SET enabled = 0 WHERE enabled <> 0')
  })
})
