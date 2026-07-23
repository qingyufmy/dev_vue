import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'

const html = readFileSync(new URL('../public/admin/index.html', import.meta.url), 'utf8')
const app = readFileSync(new URL('../public/admin/app.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../public/admin/styles.css', import.meta.url), 'utf8')
const routes = readFileSync(new URL('../server/routes/admin-console.js', import.meta.url), 'utf8')
const legacyAdmin = readFileSync(new URL('../server/routes/admin.js', import.meta.url), 'utf8')

describe('unified admin console contract', () => {
  it('ships a standalone accessible and responsive administration surface', () => {
    expect(html).toContain('id="adminMain"')
    expect(html).toContain('class="skip-link"')
    expect(html).toContain('aria-modal="true"')
    expect(css).toContain('@media (max-width:760px)')
    expect(css).toContain('min-height:44px')
    expect(css).toContain('prefers-reduced-motion')
  })

  it('uses canonical admin APIs and keeps user-facing errors in Chinese', () => {
    expect(app).toContain("api('/api/admin/overview')")
    expect(app).toContain('`/api/admin/users/${userId}`')
    expect(routes).toContain("router.patch('/admin/users/:userId'")
    expect(routes).toContain('translateAdminProfileError')
  })

  it('centralizes orders, membership notifications and referral settlement', () => {
    expect(html).toContain('data-view="commercial"')
    expect(app).toContain("api('/api/admin/commercial/overview')")
    expect(app).toContain('/api/admin/commercial/orders?')
    expect(app).toContain('/api/admin/membership-expiry-notifications?')
    expect(app).toContain('/api/admin/referrals/commissions?')
    expect(routes).toContain("router.get('/admin/commercial/orders'")
    expect(css).toContain('.segment-tabs')
    expect(css).toContain('.mobile-business-grid')
  })

  it('makes the legacy main-site editor reuse the canonical profile service', () => {
    expect(legacyAdmin).toContain("from '../admin/user-profile.js'")
    expect(legacyAdmin).toContain('updateAdminUserProfile({ actorUserId:req.user.id')
    expect(legacyAdmin).not.toContain('密码至少需要6位')
  })


  it('makes referral settlement idempotent and selects one source order', () => {
    expect(legacyAdmin).toContain('FOR UPDATE')
    expect(legacyAdmin).toContain("referral.status !== 'pending'")
    expect(legacyAdmin).toContain('SELECT latest_order.id FROM orders latest_order')
  })
})
