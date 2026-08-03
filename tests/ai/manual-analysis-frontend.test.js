import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../../public/ai/index.html', import.meta.url), 'utf8')
const app = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')
const css = readFileSync(new URL('../../public/ai/styles.css', import.meta.url), 'utf8')

describe('manual analysis background task UI contract', () => {
  it('keeps non-auto analysis resumable and leaves auto execution on the websocket path', () => {
    expect(html).toContain('id="manualInferenceAbort"')
    expect(html).toContain('取消后台任务')
    expect(app).toContain('MANUAL_ANALYSIS_TASK_STORAGE_KEY')
    expect(app).toContain('localStorage.setItem(MANUAL_ANALYSIS_TASK_STORAGE_KEY')
    expect(app).toContain('localStorage.removeItem(MANUAL_ANALYSIS_TASK_STORAGE_KEY)')
    expect(app).toContain('api("/api/ai/manual-analysis/jobs", {')
    expect(app).toContain('method:"POST"')
    expect(app).toContain('include_positions:false, auto_execute:false')
    expect(app).toContain('api(`/api/ai/manual-analysis/jobs/${encodeURIComponent(job.id)}`')
    expect(app).toContain('method:"DELETE"')
    expect(app).toContain('scheduleManualAnalysisPoll')
    expect(app).toContain('void restoreManualAnalysisJob()')
    expect(app).toContain('后台分析中')
    expect(app).toContain('关闭窗口不会取消任务')
    expect(app).toContain('if (!autoExecute) return runManualAnalysisAsync({ strategyId, symbol });')
    expect(app).toContain('wsApi("analyze", {')
    expect(app).toContain('auto_execute:autoExecute')
  })

  it('renders distinct queued, cancelled and failed states without auto-cancelling on close', () => {
    expect(app).toContain('manualAnalysisJobIsTerminal')
    expect(app).toContain('status === "cancelled" ? "后台分析已取消"')
    expect(app).toContain('status === "failed" || status === "cancelled"')
    expect(app).toContain('关闭窗口不会取消任务')
    expect(app).not.toContain('window.addEventListener("beforeunload", cancelManualAnalysisJob)')
    expect(css).toContain('.manual-inference-status.is-background')
    expect(css).toContain('.manual-inference-status.is-error')
  })

  it('stops and clears uncertain or stale provider tasks with explicit Chinese status text', () => {
    expect(app).toContain('"status_unknown", "completed_stale", "expired"')
    expect(app).toContain('服务商状态暂时无法确认，为避免重复调用未自动重试')
    expect(app).toContain('后台分析结果已过期，为避免使用过期建议未自动重试')
    expect(app).toContain('后台分析任务已过期，为避免重复调用未自动重试')
    expect(app).toContain('manualAnalysisStatusTitle(status)')
    expect(app).toContain('clearManualAnalysisTask()')
  })

  it('reads structured provider errors without exposing object coercion', () => {
    expect(app).toContain('function manualAnalysisErrorMessage(value)')
    expect(app).toContain('value.code ?? value.error_code ?? value.reason_code')
    expect(app).toContain('value.message ?? value.detail ?? value.reason')
    expect(app).toContain('manualAnalysisErrorMessage(job.error || job.error_code || "")')
    expect(app).toContain('result?.signal || result?.result?.signal')
    expect(app).not.toContain('apiErrorMessage(String(job.error))')
  })
})
