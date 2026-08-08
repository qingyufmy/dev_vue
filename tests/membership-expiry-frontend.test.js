import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'

const main = readFileSync(new URL('../public/src/main.js', import.meta.url), 'utf8')
const mainCss = readFileSync(new URL('../public/src/style.css', import.meta.url), 'utf8')
const ai = readFileSync(new URL('../public/ai/app.js', import.meta.url), 'utf8')
const aiCss = readFileSync(new URL('../public/ai/styles.css', import.meta.url), 'utf8')
const notifications = readFileSync(new URL('../server/membership-expiry-notifications.js', import.meta.url), 'utf8')

describe('membership expiry frontend reminders', () => {
  it('keeps independent reminder acknowledgements on the main site and AI lab', () => {
    expect(main).toContain('/api/membership-expiry-reminders?surface=main')
    expect(main).toContain("acknowledgeMembershipExpiryReminder(reminder.id, 'main')")
    expect(ai).toContain('/api/membership-expiry-reminders?surface=ai')
    expect(ai).toContain('body:{ surface:"ai" }')
  })

  it('opens subscription renewal in the canonical account center', () => {
    expect(main).toContain("openMainAccountCenter('subscription')")
    expect(main).not.toContain("if (renew) navigate('membership')")
    expect(ai).toContain('openAccountCenter("subscription")')
    expect(ai).not.toContain('window.location.href = "/membership"')
    expect(notifications).toContain('${siteUrl}/account/?tab=subscription')
    expect(notifications).not.toContain('${siteUrl}/membership')
  })

  it('uses accessible responsive dialogs with reduced-motion support', () => {
    for (const source of [main, ai]) {
      expect(source).toContain('role="dialog"')
      expect(source).toContain('aria-modal="true"')
      expect(source).toContain('aria-label="关闭会员到期提醒"')
    }
    for (const css of [mainCss, aiCss]) {
      expect(css).toContain('.membership-expiry-dialog')
      expect(css).toContain('@media (max-width: 520px)')
      expect(css).toContain('@media (prefers-reduced-motion: reduce)')
      expect(css).toContain('min-height: 44px')
    }
  })
})
