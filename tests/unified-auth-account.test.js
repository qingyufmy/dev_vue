import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const main = readFileSync(new URL('../public/src/main.js', import.meta.url), 'utf8')
const aiHtml = readFileSync(new URL('../public/ai/index.html', import.meta.url), 'utf8')
const aiApp = readFileSync(new URL('../public/ai/app.js', import.meta.url), 'utf8')
const aiCss = readFileSync(new URL('../public/ai/styles.css', import.meta.url), 'utf8')
const aiResponsiveCss = readFileSync(new URL('../public/ai/responsive.css', import.meta.url), 'utf8')
const adminApp = readFileSync(new URL('../public/admin/app.js', import.meta.url), 'utf8')

describe('unified authentication and account entry points', () => {
  it('uses route-backed login, registration, and account pages while preserving legacy profile links', () => {
    expect(main).toContain("if (clean === '/account') return { view: 'profile' }")
    expect(main).toContain("if (clean === '/profile') return { view: 'profile', canonicalPath:'/account' }")
    expect(main).toContain("if (clean === '/auth' || clean === '/auth/login')")
    expect(main).toContain("if (clean === '/auth/register')")
    expect(main).toContain("case 'profile': return '/account'")
  })

  it('keeps protected return paths local and supports returning to the AI laboratory', () => {
    expect(main).toContain("'/ai',")
    expect(main).toContain('target.origin !== window.location.origin')
    expect(main).toContain("getSafeLoginReturnPath(urlParams.get('next')) || '/account'")
    expect(aiHtml).toContain("window.location.replace('/auth/login?next=%2Fai%2F')")
    expect(aiApp).toContain('window.location.href = "/auth/login?next=%2Fai%2F"')
  })

  it('opens membership, billing, and account settings in the one canonical account center', () => {
    expect(aiHtml).toContain('class="icon-btn topbar-account-link" href="/account"')
    expect(aiApp).toContain("window.location.href='/account?tab=subscription'")
    expect(adminApp).toContain("location.href = '/account'")
    expect(main).toContain("`/account?tab=${encodeURIComponent(settingsTab)}`")
    expect(aiCss).toContain('.topbar-account-link')
    expect(aiResponsiveCss).toContain('.topbar-account-link span')
  })

  it('redirects expired administrator sessions through the canonical login page', () => {
    expect(adminApp).toContain('`/auth/login?next=${encodeURIComponent(\'/admin/\')}`')
    expect(adminApp).not.toContain('/?auth=login&next=')
  })
})
