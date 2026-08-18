import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const app = readFileSync(new URL('../../public/ai/app.js', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../../public/ai/styles.css', import.meta.url), 'utf8')

describe('daily period review v3 frontend contract', () => {
  it('keeps v2 compatible while routing v3 to nested trade and experience editors', () => {
    expect(app).toContain('content.output_contract_version === "daily-period-review-v3"')
    expect(app).toContain('renderDailyV3TradeAssessments(assessments, editable, evidence.sources || [])')
    expect(app).toContain('renderDailyV3ExperienceRules(content.experience_rules || [], editable)')
    expect(app).toContain('["daily_lessons", "当日经验"]')
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
    expect(app).not.toContain('? [["repeated_issues", "重复出现的问题"], ["strengths", "做得好的地方"]')
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
