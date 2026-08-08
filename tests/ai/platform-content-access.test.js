import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { canManagePlatformAiContent, isObserverSourceAccount, platformAiContentManagerSql } from '../../server/routes/ai/platform-content-access.js'

describe('observer source platform AI content access', () => {
  it('recognizes only the dedicated observer source identity', () => {
    expect(isObserverSourceAccount({ role:'user', plan_source:'observer_source' })).toBe(true)
    expect(isObserverSourceAccount({ role:'admin', plan_source:'observer_source' })).toBe(false)
    expect(isObserverSourceAccount({ role:'user', plan_source:'paid' })).toBe(false)
  })

  it('grants platform content management without changing global role', () => {
    expect(canManagePlatformAiContent({ role:'admin' })).toBe(true)
    expect(canManagePlatformAiContent({ role:'user', plan_source:'observer_source' })).toBe(true)
    expect(canManagePlatformAiContent({ role:'user', plan_source:'paid' })).toBe(false)
  })

  it('keeps SQL eligibility aligned with the runtime identity rule', () => {
    expect(platformAiContentManagerSql('source_user')).toBe("(source_user.role = 'admin' OR (source_user.role = 'user' AND source_user.plan_source = 'observer_source'))")
  })

  it('forces observer-source strategy creation to platform scope and preserves admin-only navigation', () => {
    const routes = readFileSync(new URL('../../server/routes/ai/index.js', import.meta.url), 'utf8')
    const app = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')
    expect(routes).toContain("{ ...(req.body || {}), scope:'platform' }")
    expect(routes).toContain("scope: observerSource ? 'platform'")
    expect(app).toContain("role === 'user' && planSource === 'observer_source'")
    expect(app).toContain("el.classList.contains('platform-content-only')")
    expect(app).toContain("item.classList.contains('admin-only') || isAdmin")
  })
})
