import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const html = readFileSync(new URL('../../public/ai/index.html', import.meta.url), 'utf8')
const app = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../../public/ai/styles.css', import.meta.url), 'utf8')
const responsiveCss = readFileSync(new URL('../../public/ai/responsive.css', import.meta.url), 'utf8')

describe('model management workbench frontend', () => {
  it('ships the task-first command area, purpose grid, and searchable model directory', () => {
    expect(html).toContain('data-model-management="true"')
    expect(html).toContain('data-model-management-section="purpose"')
    expect(html).toContain('data-model-management-section="directory"')
    expect(html).toContain('模型中枢')
    expect(html).toContain('id="modelCatalogSearch"')
    expect(html).toContain('placeholder="搜索模型名或供应商"')
    expect(html).toContain('id="modelCatalogStatus"')
    expect(html).toContain('全部模型')
    expect(html).toContain('连接可用')
    expect(html).toContain('默认模型')
    expect(html).toContain('id="modelCatalogEmptyState"')
    expect(html).toContain('id="modelCatalogResultCount"')
  })

  it('keeps model API and data-action contracts while filtering locally', () => {
    expect(app).toContain('function modelCatalogProfiles()')
    expect(app).toContain('state.modelCatalogSearch')
    expect(app).toContain('state.modelCatalogStatus')
    expect(app).toContain('model_name')
    expect(app).toContain('modelProviderLabel(profile.provider)')
    expect(app).toContain('model-purpose-bindings?scope=${encodeURIComponent(purposeScope)}')
    expect(app).toContain('body: { scope, model_profile_id: modelProfileId }')
    expect(app).toContain('data-model-purpose="${purpose}"')
    expect(app).toContain('data-purpose-select')
    expect(app).toContain('data-save-model-purpose')
    for (const action of ['test', 'default', 'edit', 'delete']) {
      expect(app).toContain(`data-model-action="${action}"`)
    }
    expect(app).toContain('data-model-catalog-clear')
    expect(app).toContain('/api/ai/model-profiles/${id}/test')
    expect(app).toContain('/api/ai/model-profiles/${id}/default')
  })

  it('groups editor fields without changing their IDs and keeps touch/focus responsive rules', () => {
    expect(html).toContain('<legend>基础连接</legend>')
    expect(html).toContain('<legend>模型能力</legend>')
    for (const id of ['profileProvider', 'profileModelName', 'profileBaseUrl', 'profileApiKey', 'profileTemperature', 'profileContextWindowTokens', 'profileMaxInputTokens', 'profileMaxOutputTokens', 'profileRequestTimeout', 'profileThinkingEnabled']) {
      expect(html).toContain(`id="${id}"`)
    }
    expect(html).toContain('id="cancelModelProfileBtn"')
    expect(html).toContain('id="saveModelProfileBtn"')
    expect(css).toContain('.model-management-workbench')
    expect(css).toContain('.model-profile-grid')
    expect(css).toContain('.model-management-workbench .model-profile-dialog {')
    expect(css).toContain('overflow-x: hidden')
    expect(css).toContain('.model-management-workbench .model-profile-dialog :is(#cancelModelProfileBtn, #saveModelProfileBtn)')
    expect(css).toContain('min-height: 44px')
    expect(css).toContain(':focus-visible')
    expect(css).toContain('transition: transform 180ms ease')
    expect(responsiveCss).toContain('@media (max-width: 375px)')
    expect(responsiveCss).toContain('.model-management-workbench .model-profile-grid')
    expect(responsiveCss).toContain('min-height: 44px')
  })

  it('uses the shared v key with the scoped model-management cache suffix', () => {
    const stylesheetVersion = html.match(/styles\.css\?v=([0-9a-z]+)/)?.[1]
    const appVersion = html.match(/app\.js\?v=([0-9a-z]+)/)?.[1]
    expect(appVersion).toBe('20260814ema34toggle1')
    expect(stylesheetVersion).toBe(appVersion)
    expect(html).toContain('styles.css?v=20260814ema34toggle1&rev=')
    expect(html).toContain('responsive.css?v=20260814ema34toggle1&rev=')
    expect(html).toContain('model-management-workbench1')
    expect(html).toContain('build=signalbandwidth1-notifications1-analysisloading1-')
    expect(html).toContain('history-ticket-binding1-model-management-workbench1')
  })
})
