import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

const main = readFileSync(new URL('../public/src/main.js', import.meta.url), 'utf8')
const mainHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
const mainCss = readFileSync(new URL('../public/src/style.css', import.meta.url), 'utf8')
const aiHtml = readFileSync(new URL('../public/ai/index.html', import.meta.url), 'utf8')
const aiApp = readFileSync(new URL('../public/ai/app.js', import.meta.url), 'utf8')
const aiCss = readFileSync(new URL('../public/ai/styles.css', import.meta.url), 'utf8')
const aiResponsiveCss = readFileSync(new URL('../public/ai/responsive.css', import.meta.url), 'utf8')
const adminApp = readFileSync(new URL('../public/admin/app.js', import.meta.url), 'utf8')
const aiAuthHtml = readFileSync(new URL('../public/ai/auth/index.html', import.meta.url), 'utf8')
const aiAuthApp = readFileSync(new URL('../public/ai/auth/app.js', import.meta.url), 'utf8')
const aiAuthCss = readFileSync(new URL('../public/ai/auth/styles.css', import.meta.url), 'utf8')
const accountHtml = readFileSync(new URL('../public/account/index.html', import.meta.url), 'utf8')
const accountApp = readFileSync(new URL('../public/account/app.js', import.meta.url), 'utf8')
const accountCss = readFileSync(new URL('../public/account/styles.css', import.meta.url), 'utf8')
const session = readFileSync(new URL('../public/shared/session.js', import.meta.url), 'utf8')

describe('unified authentication and account entry points', () => {
  it('repairs a legacy localStorage-only login before websocket connection', () => {
    const values = new Map([['authToken', 'legacy browser token']])
    const localStorage = {
      getItem:key => values.get(key) || null,
      setItem:(key, value) => values.set(key, String(value)),
      removeItem:key => values.delete(key),
    }
    let cookie = ''
    const document = {}
    Object.defineProperty(document, 'cookie', {
      get:() => cookie,
      set:value => { cookie = String(value).split(';')[0] },
    })
    const window = { location:{ protocol:'https:' } }

    runInNewContext(session, { window, document, localStorage })

    expect(cookie).toBe('ws_token=legacy%20browser%20token')
    expect(window.AuthSession.token()).toBe('legacy browser token')
    expect(window.AuthSession.syncCookie()).toBe('legacy browser token')
  })

  it('keeps main-site authentication while giving the AI laboratory an independent auth frontend', () => {
    expect(main).toContain("if (clean === '/auth' || clean === '/auth/login')")
    expect(main).toContain("if (clean === '/auth/register')")
    expect(aiAuthHtml).toContain('id="authFlowDialog"')
    expect(aiAuthHtml).toContain('closedby="closerequest"')
    expect(aiAuthApp).toContain("api('/api/login'")
    expect(aiAuthApp).toContain("api('/api/register'")
    expect(aiAuthApp).toContain("api('/api/reset-password'")
    expect(accountApp).toContain("api('/api/auth/logout-all'")
    expect(aiAuthHtml).toContain('workflow-card')
    expect(aiAuthApp).toContain('auth-form-register')
    expect(aiAuthCss).toContain('.auth-flow-dialog[data-flow="reset"]')
    expect(aiAuthCss).toContain('.auth-form-register')
    expect(aiAuthCss).toContain('.auth-register-entry')
  })

  it('validates the code destination before opening captcha and keeps cancel controls out of submission', () => {
    expect(aiAuthApp.indexOf('validateCodeTarget()')).toBeLessThan(aiAuthApp.indexOf('await loadCaptcha()'))
    expect(aiAuthApp).toContain("throw new Error(message)")
    expect(aiAuthHtml).toContain('type="button" class="dialog-close" data-close-captcha')
    expect(aiAuthHtml).toContain('type="button" class="button secondary" data-close-captcha')
    expect(aiAuthHtml).toContain('type="button" class="dialog-close" data-close-auth-flow')
    expect(aiAuthApp).toContain("document.querySelectorAll('[data-close-captcha]')")
    expect(aiAuthApp).toContain("event.preventDefault(); closeAuthFlow()")
    expect(aiAuthApp).toContain("querySelector('.auth-flow-header [data-close-auth-flow]').addEventListener('click', closeAuthFlow)")
    expect(aiAuthApp).not.toContain("captchaForm\" method=\"dialog")
  })

  it('prefers phone registration whenever phone authentication is available', () => {
    expect(aiAuthApp).toContain("regType:'phone'")
    expect(aiAuthApp.indexOf('<span>手机号注册</span>')).toBeLessThan(aiAuthApp.indexOf('<span>邮箱注册</span>'))
    expect(aiAuthApp).toContain("state.regType = state.authMethods.phoneEnabled ? 'phone' : 'email'")
  })

  it('shows and updates accessible password requirements for registration and password recovery', () => {
    for (const text of ['8–32 位字符', '至少 1 个字母', '至少 1 个数字']) expect(aiAuthApp).toContain(text)
    expect(aiAuthApp).toContain("passwordField('registerPassword','设置密码','new-password','rules')")
    expect(aiAuthApp).toContain("passwordField('resetPassword','新密码','new-password','rules')")
    expect(aiAuthApp).toContain("bindPasswordValidation(root,'registerPassword','registerConfirmPassword')")
    expect(aiAuthApp).toContain("bindPasswordValidation(root,'resetPassword','resetConfirmPassword')")
    expect(aiAuthApp).toContain("aria-live=\"polite\">输入密码后将实时检查格式")
    expect(aiAuthApp).toContain("fieldFeedback(confirmId,'两次输入的密码一致','success')")
    expect(aiAuthCss).toContain('.password-rule-list li[data-state="valid"]')
    expect(aiAuthCss).toContain('.password-guidance[data-state="invalid"]')
    expect(aiAuthHtml).toContain('20260724auth4')
  })

  it('uses the AI auth password rules and live confirmation feedback on main-site registration and recovery', () => {
    expect(main).toContain('function getAuthPasswordRuleError(password)')
    expect(main).toContain('password.length < 8 || password.length > 32')
    expect(main).toContain('/[A-Za-z]/.test(password)')
    expect(main).toContain('/[0-9]/.test(password)')
    expect(main).toContain("passwordPlaceholder: '8-32位，至少包含字母和数字'")
    expect(main).toContain("if (e.target.name === 'password' || e.target.name === 'confirmPassword')")
    expect(main).toContain("confirmHint.textContent = '两次输入的密码不一致'")
    expect(main).toContain("confirmHint.textContent = '两次输入的密码一致'")
    expect(main.match(/getAuthPasswordRuleError\(data\.password\)/g)).toHaveLength(2)
    expect(mainHtml).toContain('20260724authrules1')
  })

  it('shows server-authoritative membership access states after AI login', () => {
    expect(aiHtml).toContain('membershipGateTitle')
    expect(aiHtml).toContain('membershipGateAccess')
    expect(aiHtml).toContain('只观摩，不连接个人账户')
    expect(aiHtml).toContain('连接自己的 MT5 账户')
    expect(aiApp).toContain("accessRes.access?.mode === 'blocked'")
    expect(aiApp).toContain('renderMembershipAccessState')
    expect(aiApp).toContain('工作区资料仍然保留')
    expect(aiApp).toContain("'免费账户 · 需要开通会员'")
    expect(aiApp).toContain("'会员已到期 · 需要续费'")
    expect(aiCss).toContain('Membership access lobby')
    expect(aiCss).toContain('.membership-account-fact')
    expect(aiCss).toContain('.membership-plan-option.is-current-plan')
    expect(aiHtml).not.toContain('🔒')
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
    expect(accountApp).toContain("['ai','main','admin']")
    expect(accountApp).toContain('account-admin-embedded')
    expect(accountCss).toContain('body.account-admin-embedded .account-topbar-actions .icon-button')
    expect(adminApp).toContain("openAdminAccountCenter('overview')")
    expect(adminApp).toContain('/account/?embed=admin&tab=')
    expect(adminApp).toContain('handleAdminAccountCenterMessage')
    expect(mainHtml).toContain('id="mainAccountCenterModal"')
    expect(mainHtml).toContain('id="mainAccountCenterFrame"')
    expect(main).toContain("openMainAccountCenter('overview')")
    expect(main).toContain("openMainAccountCenter('notifications')")
    expect(main).toContain('/account/?embed=main&tab=')
    expect(mainCss).toContain('.main-account-center-dialog')
    expect(aiCss).toContain('.topbar-account-link')
    expect(aiResponsiveCss).toContain('.topbar-account-link span')
  })

  it('shares one browser session and logs out the main site and AI laboratory together', () => {
    expect(session).toContain("localStorage.removeItem('ws_token')")
    expect(session).toContain("localStorage.removeItem('authToken')")
    expect(aiApp).toContain('window.AuthSession.clear()')
    expect(aiApp).toContain('window.location.href = "/ai/auth/?mode=login"')
    expect(main).toContain("localStorage.setItem('ws_session_event'")
    expect(session).toContain('function syncCookie()')
    expect(session).toContain('syncCookie()')
  })

  it('keeps embedded account content visible on mobile screens', () => {
    expect(accountCss).toContain('body.account-embedded .account-sidebar { top:auto; height:auto; }')
  })

  it('synchronizes the main-site account modal with light and dark themes', () => {
    expect(accountApp).toContain("embedMode === 'main'")
    expect(accountApp).toContain("event.data?.type==='account-center-theme'")
    expect(accountCss).toContain('body.account-main-embedded:not(.account-main-dark)')
    expect(main).toContain("type:'account-center-theme'")
  })

  it('uses theme-aware compact scrollbars in both embedded account centers', () => {
    expect(accountCss).toContain('--scrollbar-thumb:rgba(148,163,184,.34)')
    expect(accountCss).toContain('--scrollbar-thumb:rgba(47,93,84,.28)')
    expect(accountCss).toContain('*::-webkit-scrollbar { width:9px; height:9px; }')
  })

  it('redirects expired administrator sessions through the canonical login page', () => {
    expect(adminApp).toContain('`/auth/login?next=${encodeURIComponent(\'/admin/\')}`')
    expect(adminApp).not.toContain('/?auth=login&next=')
  })
})
