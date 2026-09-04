import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const featureFile = (path: string) => readFileSync(resolve(process.cwd(), 'src/features/reviewer', path), 'utf8')

describe('reviewer workspace components', () => {
  it('keeps the three review workflows and deep-link query state', () => {
    const view = featureFile('views/ReviewerView.vue')
    expect(view).toContain('<Tabs v-model="section"')
    expect(view).toContain('value="period"')
    expect(view).toContain('value="manual"')
    expect(view).toContain('value="memory"')
    expect(view).toContain('route.query.case_id')
    expect(view).toContain('route.query.memory_id')
    expect(view).toContain('memorySheetOpen.value = Boolean(id)')
  })

  it('uses the typed V4 review client rather than feature-local endpoints', () => {
    const api = featureFile('api/reviewer-api.ts')
    const workspace = featureFile('composables/use-reviewer-workspace.ts')
    for (const method of ['listReviewCases', 'getReviewCase', 'listManualReviewCandidates', 'createManualReviewCase', 'createReviewVersion', 'confirmReviewVersion', 'returnReviewCase', 'listStrategyMemories', 'getStrategyMemory', 'listMemoryUpdates', 'decideMemoryUpdate']) {
      expect(api).toContain(`client.${method}`)
      expect(workspace).toContain(`reviewerApi.${method}`)
    }
    expect(api).not.toContain('/review-periods')
    expect(api).not.toContain('/review-items')
  })

  it('keeps detailed evidence progressive and preserves the original body last', () => {
    const detail = featureFile('components/ReviewCaseDetail.vue')
    expect(detail).toContain('<Progress')
    expect(detail).toContain('四层评价')
    expect(detail).toContain('证据链')
    expect(detail.indexOf('证据链')).toBeLessThan(detail.indexOf('完整 AI 正文'))
    expect(detail).toContain('whitespace-pre-wrap')
  })

  it('requires candidate selection and an analysis strategy for manual review', () => {
    const manual = featureFile('components/ManualReviewPanel.vue')
    const workspace = featureFile('composables/use-reviewer-workspace.ts')
    expect(manual).toContain('<Checkbox')
    expect(manual).toContain('<Select v-model="strategyId">')
    expect(workspace).toContain('selection_tokens')
    expect(manual).toContain('min-h-11')
  })

  it('keeps memory decisions aligned with evidence collection state', () => {
    const detail = featureFile('components/MemoryDetailSheet.vue')
    const workspace = featureFile('composables/use-reviewer-workspace.ts')
    expect(detail).toContain('累计证据中')
    expect(detail).toContain("update.status === 'awaiting_confirmation'")
    expect(detail).toContain("update.status === 'merged'")
    expect(detail).toContain("requestDecision(update, 'revoke')")
    expect(workspace).toContain("decision === 'revoke' ? 'revoke'")
    expect(workspace).toContain('update.revision')
    expect(workspace).not.toContain('update.expectedLibraryRevision ?? update.revision')
  })

  it('subscribes to user-scoped review invalidations and resyncs HTTP before reconnecting', () => {
    const realtime = featureFile('realtime/reviewer-realtime.ts')
    expect(realtime).toContain("kind: 'reviews'")
    expect(realtime).toContain('after_revision: null')
    expect(realtime).toContain('void input.resync().then')
    expect(realtime).toContain('reviewRealtimeEventSchema.safeParse')
  })
})
