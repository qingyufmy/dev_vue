import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const main = readFileSync(new URL('../public/src/main.js', import.meta.url), 'utf8')
const aiHtml = readFileSync(new URL('../public/ai/index.html', import.meta.url), 'utf8')
const aiApp = readFileSync(new URL('../public/ai/app.js', import.meta.url), 'utf8')
const aiCss = readFileSync(new URL('../public/ai/styles.css', import.meta.url), 'utf8')
const aiResponsiveCss = readFileSync(new URL('../public/ai/responsive.css', import.meta.url), 'utf8')
const adminApp = readFileSync(new URL('../public/admin/app.js', import.meta.url), 'utf8')
const aiAuthHtml = readFileSync(new URL('../public/ai/auth/index.html', import.meta.url), 'utf8')
const aiAuthApp = readFileSync(new URL('../public/ai/auth/app.js', import.meta.url), 'utf8')
const accountHtml = readFileSync(new URL('../public/account/index.html', import.meta.url), 'utf8')
const accountApp = readFileSync(new URL('../public/account/app.js', import.meta.url), 'utf8')
const accountCss = readFileSync(new URL('../public/account/styles.css', import.meta.url), 'utf8')
const session = readFileSync(new URL('../public/shared/session.js', import.meta.url), 'utf8')

describe('unified authentication and account entry points', () => {
  it('keeps main-site authentication while giving the AI laboratory an independent auth frontend', () => {
    expect(main).toContain("if (clean === '/auth' || clean === '/auth/login')")
    expect(main).toContain("if (clean === '/auth/register')")
    expect(aiAuthHtml).toContain('id="authModeTabs"')
    expect(aiAuthApp).toContain("api('/api/login'")
    expect(aiAuthApp).toContain("api('/api/register'")
    expect(aiAuthApp).toContain("api('/api/reset-password'")
  })

  it('keeps protected return paths local and supports returning to the AI laboratory', () => {
    expect(main).toContain("'/ai',")
    expect(main).toContain('target.origin !== window.location.origin')
    expect(main).toContain("getSafeLoginReturnPath(urlParams.get('next')) || '/account'")
    expect(aiHtml).toContain("window.location.replace('/ai/auth/?mode=login&next=%2Fai%2F')")
    expect(aiApp).toContain('window.location.href = "/ai/auth/?mode=login&next=%2Fai%2F"')
    expect(aiAuthApp).toContain("url.origin !== location.origin")
  })

  it('opens membership, billing, and account settings in the one canonical account center', () => {
    expect(aiHtml).toContain('id="accountCenterBtn"')
    expect(aiHtml).toContain('id="accountCenterFrame"')
    expect(aiApp).toContain('/account/?embed=ai&tab=')
    expect(accountHtml).toContain('id="accountNav"')
    expect(accountApp).toContain("api('/api/profile')")
    expect(accountApp).toContain("api('/api/plans')")
    expect(accountApp).toContain("api('/api/payment'")
    expect(adminApp).toContain("location.href = '/account'")
    expect(main).toContain("window.location.href = '/account/'")
    expect(aiCss).toContain('.topbar-account-link')
    expect(aiResponsiveCss).toContain('.topbar-account-link span')
  })

  it('shares one browser session and logs out the main site and AI laboratory together', () => {
    expect(session).toContain("localStorage.removeItem('ws_token')")
    expect(session).toContain("localStorage.removeItem('authToken')")
    expect(aiApp).toContain('window.AuthSession.clear()')
    expect(aiApp).toContain('window.location.href = "/ai/auth/?mode=login"')
    expect(main).toContain("localStorage.setItem('ws_session_event'")
  })

  it('keeps embedded account content visible on mobile screens', () => {
    expect(accountCss).toContain('body.account-embedded .account-sidebar { top:auto; height:auto; }')
  })

  it('redirects expired administrator sessions through the canonical login page', () => {
    expect(adminApp).toContain('`/auth/login?next=${encodeURIComponent(\'/admin/\')}`')
    expect(adminApp).not.toContain('/?auth=login&next=')
  })
})
