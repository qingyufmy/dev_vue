import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'

const html = readFileSync(new URL('../public/admin/index.html', import.meta.url), 'utf8')
const app = readFileSync(new URL('../public/admin/app.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../public/admin/styles.css', import.meta.url), 'utf8')

describe('admin notification center frontend contract', () => {
  it('places a first-level notification center in the user-to-commercial workflow', () => {
    expect(html.indexOf('data-view="users"')).toBeLessThan(html.indexOf('data-view="notifications"'))
    expect(html.indexOf('data-view="notifications"')).toBeLessThan(html.indexOf('data-view="commercial"'))
    expect(app).toContain("notifications:'通知中心'")
    expect(app).toContain("else if (view === 'notifications') await renderNotificationCenterPage()")
  })

  it('renders the two notification tabs and bounded editor fields', () => {
    expect(app).toContain('data-notification-center-tab="compose"')
    expect(app).toContain('data-notification-center-tab="records"')
    expect(app).toContain('name="notificationScope" value="user"')
    expect(app).toContain('name="notificationScope" value="plans"')
    expect(app).toContain('name="notificationScope" value="all"')
    for (const plan of ['free', 'plus', 'pro', 'expired']) expect(app).toContain(`value="${plan}"`)
    expect(app).toContain('maxlength="100"')
    expect(app).toContain('maxlength="1000"')
    expect(app).toContain('name="notificationPriority" value="normal"')
    expect(app).toContain('name="notificationPriority" value="important"')
    expect(app).toContain('id="notificationEmailEnabled"')
    expect(app).toContain('站内信</strong><small>固定开启')
  })

  it('uses preview tokens, idempotency keys and the explicit all-user confirmation', () => {
    expect(app).toContain("api('/api/admin/notifications/preview'")
    expect(app).toContain("api('/api/admin/notifications/campaigns'")
    expect(app).toContain("headers:{'Idempotency-Key':draft.createIdempotencyKey}")
    expect(app).toContain('payload.previewToken')
    expect(app).toContain('payload.confirmedRecipientCount')
    expect(app).toContain("'发送给全部用户'")
    expect(app).toContain('error.status === 409')
  })

  it('supports campaign history, detail pagination, cancellation, retries and unknown mail warnings', () => {
    expect(app).toContain("api(`/api/admin/notifications/campaigns?${params}`)")
    expect(app).toContain("/api/admin/notifications/campaigns/${encodeURIComponent(campaignId)}?page=")
    expect(app).toContain('/retry-failed-email')
    expect(app).toContain('/cancel`')
    expect(app).toContain('可能已投递')
    expect(app).toContain('可能造成重复邮件')
  })

  it('gives needs-review campaigns a cancel-only scope-drift resolution', () => {
    expect(app).toContain("['queued','materializing','sending','cancelling','needs_review'].includes(status)")
    expect(app).toContain('notification-needs-review-banner')
    expect(app).toContain('实际接收人数与确认值不一致，系统未开始投递；取消后按最新范围重新预览创建。')
    expect(app).not.toContain('强制继续投递')
    expect(css).toContain('.notification-needs-review-banner')
  })

  it('keeps the editor usable on 761–900px and narrow screens with accessible feedback', () => {
    expect(css).toContain('.notification-compose-layout { display:grid; grid-template-columns:minmax(0,2fr) minmax(300px,1fr)')
    expect(css).toContain('@media (min-width:761px) and (max-width:900px)')
    expect(css).toContain('.notification-compose-layout { grid-template-columns:1fr; }')
    expect(css).toContain('.notification-summary-body { min-height:250px')
    expect(css).toContain('.notification-summary-actions .primary-button { width:100%; min-height:46px; }')
    expect(css).toContain('@media (prefers-reduced-motion:reduce)')
    expect(app).toContain('aria-live="polite"')
    expect(app).toContain('role="alert"')
  })

  it('links the user detail shortcut to a prefilled notification composer', () => {
    expect(app).toContain('id="sendUserNotificationButton"')
    expect(app).toContain('openNotificationCenterForUser(user)')
    expect(app).toContain("draft.userId = String(user.id)")
    expect(app).toContain("setView('notifications')")
    expect(app).toContain("document.querySelector('#notificationTitle')?.focus()")
  })

  it('offers a debounced, keyboard-friendly user search picker and clears the preview on reset', () => {
    expect(app).toContain("new URLSearchParams({ search:query, page_size:'10' })")
    expect(app).toContain("api(`/api/admin/users?${params}`)")
    expect(app).toContain('notification-user-candidate')
    expect(app).toContain('selectNotificationUser(Number(button.dataset.notificationUserIndex), root)')
    expect(app).toContain("event.key === 'ArrowDown'")
    expect(app).toContain("event.key === 'Enter'")
    expect(app).toContain('clearNotificationUser(root)')
    expect(app).toContain('draft.userId = \'\'')
    expect(app).toContain('queueNotificationPreview()')
    expect(app).toContain('escapeHtml(notificationUserCandidateLabel(user))')
  })
})
