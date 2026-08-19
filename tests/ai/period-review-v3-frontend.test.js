import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../../public/ai/styles.css', import.meta.url), 'utf8')

function loadPeriodReviewContractHelpers() {
  const start = app.indexOf('const PERIOD_REVIEW_TERMINAL_JOB_STATUSES')
  const end = app.indexOf('function renderReviewSummary', start)
  const source = app.slice(start, end)
  return new Function(`
    const AI_FRONTEND_BUILD = 'period-review-evidence-retry1'
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
    return { periodReviewV3ContentIsSafe, periodReviewV3LegacyContentIsSafe, periodReviewContractState, periodReviewCanRegenerate, periodReviewRegenerationRequestKey, periodReviewEffectiveStatus, periodReviewJobInProgress, periodReviewStageInfo, periodReviewChunkProgress }
  `)()
}

function loadPeriodReviewFailureText() {
  const start = app.indexOf('function periodReviewFailureText')
  const end = app.indexOf('function formatReviewEventTime', start)
  const source = app.slice(start, end)
  return new Function(`
    const localizeReason = value => value
    ${source}
    return periodReviewFailureText
  `)()
}

function loadPeriodReviewEventLabel(role = 'user') {
  const start = app.indexOf('const PERIOD_REVIEW_TERMINAL_JOB_STATUSES')
  const end = app.indexOf('function periodReviewProgressHtml', start)
  const source = app.slice(start, end)
  return new Function(`
    const state = { user: { role: '${role}' } }
    ${source}
    return periodReviewEventLabel
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
    expect(app).toContain('periodReviewEvidenceLimitationsHtml(item.evidence_limitations)')
    expect(app).toContain('证据精度说明')
  })

  it('distinguishes short-holding metric limits from missing market coverage', () => {
    expect(app).toContain('pathMetrics.status === "not_observable"')
    expect(app).toContain('行情覆盖完整')
    expect(app).toContain('无完整内部 M5 K 线')
    expect(app).toContain('holding_path_intrabar_unobservable')
    expect(styles).toContain('.period-review-evidence-limitations')
  })

  it('presents provider capacity as an automatic wait instead of a terminal generation failure', () => {
    expect(app).toContain('模型容量等待中')
    expect(app).toContain('额度恢复后自动续跑未完成分块')
    expect(app).toContain('model_quota_exhausted|model_quota_probe_in_progress')
    expect(app).toContain('业务生成 ${Number(review.attempt_count || 0)}/${Number(review.max_attempts || 3)}')
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

  it('keeps old v3 text findings readable but read-only and offers regeneration', () => {
    const { periodReviewV3ContentIsSafe, periodReviewV3LegacyContentIsSafe, periodReviewContractState } = loadPeriodReviewContractHelpers()
    const content = {
      output_contract_version: 'daily-period-review-v3',
      trade_assessments: [{ outcome_id: 1, outcome_attribution: {}, next_time_rule: {} }],
      repeated_issues: ['趋势判断过早', '止损距离过近'],
      strengths: ['按计划执行'],
      experience_rules: [{ category: 'risk_execution', condition: '波动放大', action: '缩小仓位', risk_control: '先确认止损', invalidation: '结构反转', prohibited_action: '禁止追单' }],
    }
    expect(periodReviewV3ContentIsSafe(content)).toBe(false)
    expect(periodReviewV3LegacyContentIsSafe(content)).toBe(true)
    expect(periodReviewContractState({}, { period_type: 'daily' }, { id: 290 }, content)).toMatchObject({ supported:true, kind:'daily-v3-legacy', legacyCompatible:true })
    expect(app).toContain('periodReviewLegacyNoticeHtml')
    expect(app).toContain('periodReviewLegacyReadOnly')
    expect(app).toContain('action !== "regenerate"')
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
    expect(app).toContain('card.querySelector("summary strong")')
  })

  it('provides responsive and keyboard-native expandable cards', () => {
    expect(app).toContain('<details class="period-review-trade-card">')
    expect(app).toContain('period-review-section-nav')
    expect(app).toContain('id="period-review-evidence"')
    expect(app).toContain('period-review-finding-card')
    expect(app).toContain('period-review-rule-card')
    expect(styles).toContain('.period-review-trade-card > summary')
    expect(styles).toContain('.period-review-v3-grid { grid-template-columns: 1fr; }')
    expect(styles).toContain('min-height: 44px')
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('navigates review sections without native hash jumps or excess bottom whitespace', () => {
    expect(app).toContain('data-review-section-target="period-review-overview"')
    expect(app).toContain('aria-current="location"')
    expect(app).not.toContain('href="#period-review-overview"')
    expect(app).toContain('function navigatePeriodReviewSection(targetId, trigger)')
    expect(app).toContain('targetRect.bottom - visibleBottom')
    expect(app).toContain('main.scrollHeight - main.clientHeight')
    expect(app).toContain('(prefers-reduced-motion: reduce)')
    expect(styles).toContain('.period-review-section-nav button[aria-current="location"]')
  })

  it('derives terminal UI state from the job and stops polling stale generating cases', () => {
    const { periodReviewEffectiveStatus, periodReviewJobInProgress } = loadPeriodReviewContractHelpers()
    expect(periodReviewEffectiveStatus({ status: 'generating', job_status: 'failed', current_version_id: null })).toBe('failed')
    expect(periodReviewJobInProgress({ status: 'generating', job_status: 'failed', current_version_id: null })).toBe(false)
    expect(periodReviewEffectiveStatus({ status: 'generating', job_status: 'succeeded', current_version_id: null })).not.toBe('succeeded')
    expect(app).toContain('return terminalJobStatus === "succeeded" ? "ready" : terminalJobStatus')
    expect(app).toContain(': Number(review.current_version_id || 0) > 0 ? "succeeded" : periodReviewEffectiveStatus(review)')
  })

  it('presents recoverable market evidence as a scheduled wait instead of a terminal failure', () => {
    const { periodReviewEffectiveStatus, periodReviewJobInProgress } = loadPeriodReviewContractHelpers()
    const review = { status:'ready', job_status:'queued', progress_stage:'evidence_retry_wait',
      next_attempt_at:'2026-08-19 11:25:00', current_version_id:null }
    expect(periodReviewEffectiveStatus(review)).toBe('evidence_retry_wait')
    expect(periodReviewJobInProgress(review)).toBe(true)
    expect(app).toContain('等待行情恢复')
    expect(app).toContain('periodReviewRetryTimeText(review.next_attempt_at)')
    expect(app).toContain('evidence_retry_count')
    expect(app).toContain('retryAtMs - Date.now() > 60000 ? 30000 : 5000')
    expect(styles).toContain('.period-review-progress.is-evidence_retry_wait')
  })

  it('localizes remediation failures for users and keeps diagnostic codes for admins only', () => {
    const failureText = loadPeriodReviewFailureText()
    expect(failureText('period_review_input_budget_exceeded')).toContain('输入容量')
    expect(failureText('invalid_daily_v3_contract_version')).toContain('格式版本')
    expect(failureText('evidence_upgrade_failed')).toContain('行情证据')
    expect(failureText('period_market_bridge_unavailable')).toContain('自动继续')
    expect(failureText('period_review_input_budget_exceeded')).not.toContain('period_review_input_budget_exceeded')

    const userLabel = loadPeriodReviewEventLabel('user')({ stage: 'preparing', message_code: 'evidence_upgrade_failed' })
    const adminLabel = loadPeriodReviewEventLabel('admin')({ stage: 'preparing', message_code: 'evidence_upgrade_failed' })
    expect(userLabel).toContain('行情证据')
    expect(userLabel).not.toContain('evidence_upgrade_failed')
    expect(adminLabel).toContain('错误码 evidence_upgrade_failed')
  })

  it('shows v3 chunk validation and checkpoint recovery without exposing internal payloads', () => {
    const { periodReviewStageInfo, periodReviewChunkProgress } = loadPeriodReviewContractHelpers()
    const stageInfo = periodReviewStageInfo({ progress_stage: 'daily_chunk_1_validating' })
    expect(stageInfo).toMatchObject({ kind: 'daily_chunk', chunkIndex: 1, phase: 'validating' })
    expect(periodReviewChunkProgress({ job_events: [
      { metadata: { chunk_count: 3 }, message_code: 'daily_review_checkpoint_restored' },
    ] }, stageInfo)).toMatchObject({ chunkIndex: 1, chunkCount: 3, checkpointRestored: true })
    const label = loadPeriodReviewEventLabel('user')({
      stage: 'daily_chunk_1_validating', message_code: 'daily_review_checkpoint_restored',
    })
    expect(label).toContain('已恢复2号分片')
    expect(label).not.toContain('daily_review_checkpoint_restored')
  })
})
