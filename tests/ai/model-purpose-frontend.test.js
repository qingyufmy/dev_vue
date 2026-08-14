import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const adminApp = readFileSync(new URL('../../public/admin/app.js', import.meta.url), 'utf8')
const adminCss = readFileSync(new URL('../../public/admin/styles.css', import.meta.url), 'utf8')
const aiApp = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')
const aiHtml = readFileSync(new URL('../../public/ai/index.html', import.meta.url), 'utf8')
const aiCss = readFileSync(new URL('../../public/ai/styles.css', import.meta.url), 'utf8')

const purposes = {
  manual_analysis: '手动分析',
  auto_inference: '自动分析',
  daily_review: '日复盘',
  monthly_review: '月复盘',
  manual_trade_review: '手动交易复盘',
  memory_compression: '记忆整理',
  memory_consistency: '一致性检查',
}

describe('model purpose assignment frontend', () => {
  it('keeps the seven purpose keys and Chinese labels in both model surfaces', () => {
    for (const [key, label] of Object.entries(purposes)) {
      expect(adminApp).toContain(key)
      expect(adminApp).toContain(label)
      expect(aiApp).toContain(key)
      expect(aiApp).toContain(label)
    }
    expect(aiHtml).toContain('modelPurposeBindingsList')
    expect(aiHtml).toContain('按用途分配模型')
  })

  it('uses scope-specific purpose endpoints and PUT payloads', () => {
    expect(adminApp).toContain('/api/ai/model-purpose-bindings?scope=platform')
    expect(adminApp).toContain("scope:'platform',model_profile_id:modelProfileId")
    expect(aiApp).toContain('model-purpose-bindings?scope=${encodeURIComponent(purposeScope)}')
    expect(aiApp).toContain('body: { scope, model_profile_id: modelProfileId }')
    expect(adminApp).toContain('model-purpose-bindings/${encodeURIComponent(purpose)}')
    expect(aiApp).toContain('model-purpose-bindings/${encodeURIComponent(purpose)}')
  })

  it('filters selectors to active profiles in the matching scope and offers inheritance', () => {
    expect(adminApp).toContain("item.scope==='platform'&&item.status==='active'")
    expect(aiApp).toContain('profile.scope === scope && profile.status === "active"')
    expect(adminApp).toContain('继承现有规则')
    expect(aiApp).toContain('继承现有规则')
    expect(adminApp).toContain('实际模型：')
    expect(aiApp).toContain('实际模型：')
  })

  it('has compact accessible styling for rows, errors, and narrow screens', () => {
    for (const css of [adminCss, aiCss]) {
      expect(css).toContain('.model-purpose-row')
      expect(css).toContain('.model-purpose-resolution')
      expect(css).toContain('.model-purpose-error')
    }
    expect(aiHtml).toContain('aria-live="polite"')
    expect(aiHtml).toContain('aria-labelledby="modelPurposeBindingsTitle"')
  })
})
