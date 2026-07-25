import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const main = readFileSync(new URL('../public/src/main.js', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../public/src/style.css', import.meta.url), 'utf8')

describe('Bridge browser pairing page', () => {
  it('keeps the pairing route behind the existing login return flow', () => {
    expect(main).toContain("'/bridge/pair',")
    expect(main).toContain("if (clean === '/bridge/pair') return { view: 'bridgePair' }")
    expect(main).toContain("case 'bridgePair': renderBridgePairing(); break")
  })

  it('requires a matching one-time user code and calls only the approval API', () => {
    expect(main).toContain("/^[A-HJ-NP-Z2-9]{8}$/")
    expect(main).toContain("api.post('/api/auth/bridge-pair/approve', { userCode })")
    expect(main).toContain('只在桌面端显示相同代码时确认')
    expect(main).not.toContain("api.post('/api/auth/bridge-session'")
  })

  it('provides explicit accessible states and responsive controls', () => {
    expect(main).toContain('role="status" aria-live="polite"')
    expect(main).toContain('授权码无效或已过期')
    expect(main).toContain('连接已确认')
    expect(styles).toContain('.bridge-pair-status-success')
    expect(styles).toContain('@media (max-width: 640px)')
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)')
  })
})
