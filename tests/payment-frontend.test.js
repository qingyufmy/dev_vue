import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'

const main = readFileSync(new URL('../public/src/main.js', import.meta.url), 'utf8')
const mainHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
const account = readFileSync(new URL('../public/account/app.js', import.meta.url), 'utf8')
const accountCss = readFileSync(new URL('../public/account/styles.css', import.meta.url), 'utf8')
const accountHtml = readFileSync(new URL('../public/account/index.html', import.meta.url), 'utf8')

describe('payment frontend safeguards', () => {
  it('shows truthful copy success/failure feedback with a clipboard fallback', () => {
    for (const source of [main, account]) {
      expect(source).toContain('copyTextWithFallback')
      expect(source).toContain('document.execCommand')
      expect(source).toContain('复制失败，请手动复制地址')
      expect(source).toContain('收款地址已复制')
    }
  })

  it('keeps the account payment sheet aligned with the main payment details', () => {
    for (const token of ['payment-amount-row', 'payment-chain-badge', 'payment-qr-section', 'payment-warning', 'payment-countdown', 'paymentConfirmations', '稍后支付']) {
      expect(account).toContain(token)
    }
    for (const token of ['.payment-amount-row', '.payment-chain-badge', '.payment-qr', '.payment-warning', '.payment-countdown', '.payment-status-row']) {
      expect(accountCss).toContain(token)
    }
  })

  it('keeps desktop payment content compact while preserving mobile scrolling', () => {
    const desktopCompact = accountCss.match(/@media \(min-width:821px\) \{([\s\S]*?)\n\}/)?.[1] || ''
    expect(desktopCompact).toMatch(/\.payment-dialog\s*\{[^}]*max-height:min\(900px,calc\(100dvh - 32px\)\)[^}]*overflow:hidden/)
    expect(desktopCompact).toMatch(/\.payment-sheet\s*\{[^}]*gap:10px[^}]*padding:16px/)
    expect(desktopCompact).toMatch(/\.payment-qr\s*\{[^}]*width:min\(100%,220px\)/)
    expect(desktopCompact).toMatch(/\.payment-order-meta\s*\{[^}]*gap:8px/)
    expect(accountCss).toMatch(/@media \(min-width:821px\) and \(max-height:746px\) \{[\s\S]*?\.payment-dialog\s*\{[^}]*overflow:auto/)
    expect(accountCss).toMatch(/@media \(max-width:820px\) \{[\s\S]*?\.payment-dialog\s*\{[^}]*overflow:auto/)
  })

  it('disables Plus purchase for active Pro users while leaving expired Pro eligible', () => {
    expect(account).toContain('当前已是 Pro，无法购买 Plus')
    expect(account).toContain('disabled aria-disabled="true"')
    expect(account).toContain('!Boolean(state.user?.membershipExpired)')
  })

  it('refreshes the changed payment frontend assets without changing the shared release key', () => {
    expect(mainHtml).toContain('/src/main.js?v=20260814ema34toggle1&build=payment-copy-feedback1')
    expect(accountHtml).toContain('/account/styles.css?v=20260814ema34toggle1&rev=payment-modal3')
    expect(accountHtml).toContain('/account/app.js?v=20260814ema34toggle1&rev=payment-modal3')
  })
})
