import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const html = readFileSync(new URL('../../public/ai/index.html', import.meta.url), 'utf8')
const app = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')

describe('inference workspace V2 contract', () => {
  it('opens manual inference from a dedicated modal', () => {
    expect(html).toContain('id="openManualInferenceBtn"')
    expect(html).toContain('id="manualInferenceModal"')
    expect(html).toContain('id="runAnalysisBtn"')
  })

  it('keeps history as a dedicated navigation rail beside the result', () => {
    expect(html).toContain('<aside class="card analysis-history-panel"')
    expect(html).toContain('历史推理')
    expect(html).not.toContain('analysis-history-panel quiet-disclosure')
  })

  it('does not expose a fake client-side cancellation control', () => {
    expect(html).not.toContain('analysisCancelBtn')
    expect(app).not.toContain('_analysisCancelled')
  })

  it('renders execution advice and separates AI and risk volume', () => {
    expect(app).toContain('执行建议')
    expect(app).toContain('AI 建议手数')
    expect(app).toContain('风控最终手数')
    expect(app).not.toContain('当前持仓数 <em class="market-unit">笔</em>')
  })
})
