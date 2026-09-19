import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { it, expect } from 'vitest'
import {
  assertConfidence, assertExplicitSnapshot, assertMarketAnalysisResult, assertTraderDecisionResult,
  type AnalysisInputSnapshot, type MarketAnalysisResult, type TraderDecisionResult, type TraderInputSnapshot,
} from '../../server/src/modules/inference/index.js'

interface RecordedCase {
  case_id: string
  role: 'analyst' | 'trader'
  output: MarketAnalysisResult | TraderDecisionResult | null
  effective_input: AnalysisInputSnapshot | TraderInputSnapshot
}

function projectErrors(rows: RecordedCase[]) {
  return rows.filter(row => row.output !== null).map(row => {
    try {
      assertExplicitSnapshot(row.effective_input)
      assertConfidence(row.output!.confidence)
      if (row.role === 'analyst') assertMarketAnalysisResult(row.output as MarketAnalysisResult)
      else assertTraderDecisionResult(row.output as TraderDecisionResult, row.effective_input as TraderInputSnapshot)
      return { case_id: row.case_id, status: 'passed', error: null }
    } catch (error) {
      return { case_id: row.case_id, status: 'failed', error: error instanceof Error ? error.message : 'contract_check_failed' }
    }
  })
}

it('checks recorded outputs through current public inference contracts without execution', () => {
  const reportPath = process.env.PROMPTLAB_PROJECT_REPORT
  if (reportPath) {
    const report = JSON.parse(readFileSync(reportPath, 'utf8')) as { results: RecordedCase[]; build_id: string }
    const results = projectErrors(report.results)
    const summary = {
      build_id: report.build_id, scope: 'current_public_inference_assertions_only',
      passed: results.filter(row => row.status === 'passed').length,
      failed: results.filter(row => row.status === 'failed').length,
      skipped_without_output: report.results.length - results.length,
      execution_authorized: false, risk_validation: 'not_tested', results,
    }
    writeFileSync(process.env.PROMPTLAB_PROJECT_CHECK!, JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' })
    expect(summary.failed).toBe(0)
    expect(results.length).toBeGreaterThan(0)
    return
  }

  const temporary = mkdtempSync(join(tmpdir(), 'promptlab-contract-'))
  try {
    const python = process.env.PROMPTLAB_PYTHON || 'python'
    const paths = JSON.parse(execFileSync(python, ['dual-prompt-lab/examples/create_demo.py', '--output', join(temporary, 'demo')],
      { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })) as { work: string; build: string; cases: string; responses: string }
    const result = JSON.parse(execFileSync(python, ['dual-prompt-lab/promptlab.py', '--work', paths.work, 'evaluate', '--build', paths.build,
      '--cases', paths.cases, '--responses', paths.responses], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })) as { report: string }
    const report = JSON.parse(readFileSync(result.report, 'utf8')) as { results: RecordedCase[] }
    expect(projectErrors(report.results).map(row => row.status)).toEqual(['passed', 'passed'])

    const changed = structuredClone(report.results[1]!)
    const changedDecision = changed.output as TraderDecisionResult
    changedDecision.actions = [{ actionId: 'a1', kind: 'close_position', parameters: { ticket: 'fixture-ticket' }, expectedState: {} }]
    changedDecision.action = 'close_position'
    expect(projectErrors([changed])[0]!.error).toBe('trader_expected_state_mismatch')
  } finally {
    if (dirname(resolve(temporary)) !== resolve(tmpdir()) || !basename(temporary).startsWith('promptlab-contract-')) throw new Error('unsafe_temp_path')
    rmSync(temporary, { recursive: true })
  }
})
