import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'

const html = readFileSync(new URL('../public/admin/index.html', import.meta.url), 'utf8')
const app = readFileSync(new URL('../public/admin/app.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../public/admin/styles.css', import.meta.url), 'utf8')
const routes = readFileSync(new URL('../server/routes/admin-console.js', import.meta.url), 'utf8')
const legacyAdmin = readFileSync(new URL('../server/routes/admin.js', import.meta.url), 'utf8')
const aiOperations = readFileSync(new URL('../server/admin/ai-operations.js', import.meta.url), 'utf8')
const riskAudit = readFileSync(new URL('../server/admin/risk-audit.js', import.meta.url), 'utf8')
const contentSystem = readFileSync(new URL('../server/admin/content-system.js', import.meta.url), 'utf8')

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

  it('moves AI runtime governance into the canonical admin console', () => {
    expect(html).toContain('data-view="ai-operations"')
    expect(app).toContain("api('/api/admin/ai/overview')")
    expect(app).toContain('/api/admin/ai/observer-sources/${source.id}/runtime')
    expect(routes).toContain("router.get('/admin/ai/overview'")
    expect(routes).toContain("router.patch('/admin/ai/observer-sources/:id/runtime'")
    expect(aiOperations).toContain('getAiRolloutHealth()')
    expect(aiOperations).toContain('getReviewAdminHealth()')
    expect(aiOperations).toContain("redis.smembers('auto:scheduler:keys')")
    expect(css).toContain('.observer-admin-grid')
  })

  it('centralizes risk status, decisions and administrator audit records', () => {
    expect(html).toContain('data-view="risk-audit"')
    expect(app).toContain('/api/admin/risk-audit/overview?')
    expect(app).toContain('/api/admin/risk-audit/admin-events?')
    expect(app).toContain("api('/api/admin/risk-audit/global-stop'")
    expect(routes).toContain("router.get('/admin/risk-audit/overview'")
    expect(routes).toContain("router.post('/admin/risk-audit/global-stop'")
    expect(riskAudit).toContain('formatRiskReason(row.reject_code')
    expect(app).not.toContain("prompt('请输入开启平台紧急停止")
    expect(css).toContain('.risk-account-list')
  })

  it('centralizes course discovery, feedback triage and release publishing', () => {
    expect(html).toContain('data-view="content-system"')
    expect(app).toContain('/api/admin/content-system/courses?')
    expect(app).toContain('/api/admin/content-system/feedback?')
    expect(app).toContain("api('/api/admin/release-notes'")
    expect(routes).toContain("router.get('/admin/content-system/overview'")
    expect(routes).toContain("router.get('/admin/content-system/courses'")
    expect(contentSystem).toContain('getAdminContentSystemOverview')
    expect(css).toContain('.content-card-list')
  })
})
