import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../../public/ai/styles.css', import.meta.url), 'utf8')

function loadPeriodReviewContractHelpers() {
  const start = app.indexOf('function periodReviewContractValues')
  const end = app.indexOf('function renderReviewSummary', start)
  const source = app.slice(start, end)
  return new Function(`
    const AI_FRONTEND_BUILD = 'period-review-contract-refresh1'
    const PERIOD_REVIEW_FRONTEND_CONTRACT_VERSION = 'period-review-ui-v1'
    const PERIOD_REVIEW_DAILY_V3_CONTRACT = 'daily-period-review-v3'
    const PERIOD_REVIEW_LEGACY_CONTRACTS = new Set([
      'daily-period-review-v1', 'daily-period-review-v2', 'period-review-v1', 'period-review-v2',
    ])
    const PERIOD_REVIEW_SUPPORTED_OUTPUT_CONTRACTS = Object.freeze([
      PERIOD_REVIEW_DAILY_V3_CONTRACT,
      ...PERIOD_REVIEW_LEGACY_CONTRACTS,
    ])
    const PERIOD_REVIEW_SUPPORTED_CONTRACTS = PERIOD_REVIEW_SUPPORTED_OUTPUT_CONTRACTS
    const PERIOD_REVIEW_REGENERATABLE_STATUSES = new Set(['draft', 'edited', 'needs_revision', 'deferred'])
    const PERIOD_REVIEW_ACTIVE_JOB_STATUSES = new Set(['queued', 'leased', 'status_unknown'])
    const state = { periodReviewRegenerateRequestKeys: new Map() }
    ${source}
    return { periodReviewV3ContentIsSafe, periodReviewContractState, periodReviewCanRegenerate, periodReviewRegenerationRequestKey }
  `)()
}

describe('daily period review v3 frontend contract', () => {
  it('keeps v2 compatible while routing v3 to nested trade and experience editors', () => {
    expect(app).toContain('const PERIOD_REVIEW_DAILY_V3_CONTRACT = "daily-period-review-v3"')
    expect(app).toContain('kind:"daily-v3"')
    expect(app).toContain('renderDailyV3TradeAssessments(assessments, editable, evidence.sources || [])')
    expect(app).toContain('renderDailyV3ExperienceRules(content.experience_rules || [], editable)')
    expect(app).toContain('当日经验（确认后沉淀）')
    expect(app).toContain('periodReviewLegacyContentIsSafe')
    expect(app).toContain('data-period-review-path')
  })

  it('shows all required pre-trade, attribution, action and evidence fields', () => {
    for (const field of [
      'original_signal_logic', 'technical_basis_assessment', 'market_alignment', 'strategy_alignment',
      'outcome_attribution.primary_causes', 'outcome_attribution.explanation', 'outcome_attribution.avoidability',
      'decision_quality', 'risk_execution_status', 'risk_execution_assessment', 'missing_evidence', 'issue_codes', 'next_time_rule',
    ]) expect(app).toContain(field)
    for (const field of ['condition','action','risk_control','invalidation','prohibited_action']) {
      expect(app).toContain(`["${field}",`)
    }
    expect(app).toContain('证据引用：')
    expect(app).toContain('period-review-trade-confidence')
  })

  it('keeps cross-trade findings attributable instead of flattening them into text lines', () => {
    expect(app).toContain('renderDailyV3Findings("repeated_issues"')
    expect(app).toContain('renderDailyV3Findings("strengths"')
    expect(app).toContain('item.source_refs')
    expect(app).toContain('item.occurrence_count')
    expect(app).toContain('periodReviewStructuredFindingIsSafe(item)')
    expect(app).not.toContain('userVisibleText(raw')
    expect(app).not.toContain('? [["repeated_issues", "重复出现的问题"], ["strengths", "做得好的地方"]')
  })

  it('renders structured v3 findings and experience rules without entering legacy string localization', () => {
    const findingsStart = app.indexOf('function renderDailyV3Findings')
    const findingsEnd = app.indexOf('function periodReviewExperienceMarkdown', findingsStart)
    const findingsBlock = app.slice(findingsStart, findingsEnd)
    expect(findingsBlock).toContain('raw && typeof raw === "object" && !Array.isArray(raw)')
    expect(findingsBlock).toContain('periodReviewStructuredFindingIsSafe(item)')
    expect(findingsBlock).toContain('periodReviewNestedField(`${key}.${index}.text`')
    const experienceStart = app.indexOf('function renderDailyV3ExperienceRules')
    const experienceEnd = app.indexOf('function removePeriodReviewExperienceRule', experienceStart)
    const experienceBlock = app.slice(experienceStart, experienceEnd)
    expect(experienceBlock).toContain('safeRules')
    expect(experienceBlock).toContain('periodReviewExperienceRuleIsSafe')
    expect(experienceBlock).toContain('periodReviewExperienceMarkdown(safeRules)')
  })

  it('accepts two structured findings and six structured experience rules as v3', () => {
    const { periodReviewV3ContentIsSafe, periodReviewContractState } = loadPeriodReviewContractHelpers()
    const content = {
      output_contract_version: 'daily-period-review-v3',
      trade_assessments: [{ outcome_id: 1, outcome_attribution: {}, next_time_rule: {} }],
      repeated_issues: [{ text: '等待确认', source_refs: ['outcome:1'], occurrence_count: 1 }, { text: '止损过近', source_refs: ['outcome:2'], occurrence_count: 1 }],
      strengths: [{ text: '按计划执行', source_refs: ['outcome:1'], occurrence_count: 1 }, { text: '及时止损', source_refs: ['outcome:2'], occurrence_count: 1 }],
      experience_rules: Array.from({ length: 6 }, (_, index) => ({
        category: 'general', condition: `条件${index}`, action: `动作${index}`, risk_control: '控制风险',
        invalidation: '结构失效', prohibited_action: '禁止追单', source_refs: [`outcome:${index + 1}`], confidence: .8,
      })),
    }
    expect(periodReviewV3ContentIsSafe(content)).toBe(true)
    expect(periodReviewContractState({}, { period_type: 'daily' }, { id: 158 }, content)).toMatchObject({ supported:true, kind:'daily-v3' })
    expect(periodReviewContractState({
      frontend_contract_version: 'period-review-ui-v1',
      period_review_contracts: ['period-review-ui-v1'],
    }, { period_type: 'daily' }, { id: 158 }, content)).toMatchObject({ supported:false, reason:'period_review_contracts' })
    expect(periodReviewV3ContentIsSafe({ ...content, strengths: [{ text: { value: '不应字符串化' } }] })).toBe(false)
  })

  it('fails closed for unknown contracts and protects write actions', () => {
    expect(app).toContain('function periodReviewContractState(')
    expect(app).toContain('function periodReviewContractMismatchHtml(')
    expect(app).toContain('页面版本已更新，请刷新后继续')
    expect(app).toContain('X-Aurum-Period-Review-Contracts')
    expect(app).toContain('periodReviewWriteActions')
    expect(app).toContain('window.location.reload()')
    expect(app).toContain('periodReviewEditorIsDirty()')
    expect(app).toContain('state.periodReviewMutationInFlight')
  })

  it('advertises output contracts separately from the frontend UI contract', () => {
    expect(app).toContain('const PERIOD_REVIEW_SUPPORTED_OUTPUT_CONTRACTS = Object.freeze([')
    expect(app).toContain('headers["X-Aurum-Period-Review-Frontend-Contract"] = PERIOD_REVIEW_FRONTEND_CONTRACT_VERSION')
    expect(app).toContain('headers["X-Aurum-Period-Review-Contracts"] = PERIOD_REVIEW_SUPPORTED_OUTPUT_CONTRACTS.join(",")')
    expect(app).not.toContain('headers["X-Aurum-Period-Review-Contracts"] = PERIOD_REVIEW_SUPPORTED_CONTRACTS.join(",")')
  })

  it('exposes explicit regeneration only for editable current versions without an active job', () => {
    const { periodReviewCanRegenerate, periodReviewRegenerationRequestKey } = loadPeriodReviewContractHelpers()
    const current = { id: 289 }
    for (const status of ['draft', 'edited', 'needs_revision', 'deferred']) {
      expect(periodReviewCanRegenerate({ status, current_version_id: 289 }, current)).toBe(true)
    }
    for (const review of [
      { status: 'approved', current_version_id: 289 },
      { status: 'generating', current_version_id: 289 },
      { status: 'draft', job_status: 'queued', job_slot: 1, current_version_id: 289 },
      { status: 'draft', job_status: 'leased', job_slot: 1, current_version_id: 289 },
      { status: 'draft', job_status: 'status_unknown', job_slot: 1, current_version_id: 289 },
      { status: 'draft', current_version_id: 288 },
    ]) expect(periodReviewCanRegenerate(review, current)).toBe(false)
    expect(periodReviewCanRegenerate({ status: 'draft', current_version_id: 289 }, null)).toBe(false)
    const requestKey = periodReviewRegenerationRequestKey(12, 289)
    expect(periodReviewRegenerationRequestKey(12, 289)).toBe(requestKey)
    expect(periodReviewRegenerationRequestKey(12, 290)).not.toBe(requestKey)
    expect(requestKey).toMatch(/^period-review-regenerate:12:289:/)
    expect(app).toContain('data-review-action="regenerate"')
    expect(app).toContain('/api/ai/period-reviews/${caseId}/regenerate')
    expect(app).toContain('headers:{"Idempotency-Key":idempotencyKey}')
    expect(app).toContain('确认重新生成这份复盘？')
    expect(app).toContain('state.periodReviewRegenerateRequestKeys')
  })

  it('supports deleting an invalid experience without making source references editable', () => {
    expect(app).toContain('data-review-action="remove-experience"')
    expect(app).toContain('removePeriodReviewExperienceRule')
    expect(app).toContain('来源交易：')
    expect(app).not.toContain('data-period-review-path="experience_rules.${index}.source_refs"')
    expect(app).toContain('实际写入文本预览')
    expect(app).toContain('JSON.stringify(content) !== state.periodReviewEditorBaseline')
    expect(app).toContain('approvalVersionId = Number(saved.versionId)')
  })

  it('provides responsive and keyboard-native expandable cards', () => {
    expect(app).toContain('<details class="period-review-trade-card"')
    expect(styles).toContain('.period-review-trade-card > summary')
    expect(styles).toContain('.period-review-v3-grid { grid-template-columns: 1fr; }')
  })
})
