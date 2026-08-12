import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const main = readFileSync(new URL('../public/src/main.js', import.meta.url), 'utf8')
const html = readFileSync(new URL('../public/ai/bridge-pair.html', import.meta.url), 'utf8')
const script = readFileSync(new URL('../public/ai/bridge-pair.js', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../public/ai/bridge-pair.css', import.meta.url), 'utf8')
const server = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8')
const bridgeUi = readFileSync(new URL(
  '../bridge/native/apps/bridge-ui/src/main.rs', import.meta.url), 'utf8')

describe('Bridge authorization in the AI trading lab', () => {
  it('serves the authorization page in the AI lab and redirects the old URL', () => {
    expect(server).toContain("app.get('/ai/bridge/pair', noCache")
    expect(server).toContain("app.get('/bridge/pair', noCache")
    expect(server).toContain("res.redirect(308, `/ai/bridge/pair")
    expect(main).not.toContain("if (clean === '/bridge/pair') return { view: 'bridgePair' }")
    expect(html).toContain('<strong>AI交易实验室</strong>')
    expect(html).toContain('量见智桥授权')
    expect(html).toContain('<h1 id="pairTitle">连接量见智桥</h1>')
    expect(script).toContain('量见智桥已获得连接权限')
  })

  it('returns unauthenticated users to the AI page after login', () => {
    expect(html).toContain('/shared/session.js')
    expect(script).toContain('window.AuthSession.token()')
    expect(script).toContain('`/ai/auth/?mode=login&next=${encodeURIComponent(next)}`')
  })

  it('allows an administrator to select an observer source for an isolated profile', () => {
    expect(script).toContain("api('/api/ai/admin/observer-source-candidates')")
    expect(script).toContain("item.plan_source === 'observer_source'")
    expect(script).toContain('bridgeUserId:Number($(\'bridgeSource\').value)')
    expect(html).toContain('每个观摩源使用独立桥接档案')
  })

  it('opens a browser only from the explicit connect-account action', () => {
    expect(bridgeUi).toContain('CONTROL_PAIR => unsafe { begin_action(hwnd, app, LocalControlAction::Pair) }')
    expect(bridgeUi).toContain('LocalControlResult::PairingUrl { url }')
    expect(bridgeUi).toContain('open_browser(&url)')
    expect(bridgeUi).not.toContain('automatic_pairing_started')
  })

  it('provides accessible status and responsive controls', () => {
    expect(html).toContain('role="status" aria-live="polite"')
    expect(html).toContain('/ai/bridge-pair.css?v=20260812historypref2')
    expect(html).toContain('/ai/bridge-pair.js?v=20260812historypref2')
    expect(styles).toContain('@media (max-width:560px)')
    expect(styles).toContain('@media (prefers-reduced-motion:reduce)')
  })
})
