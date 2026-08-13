import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const root = new URL('../../', import.meta.url)
const app = readFileSync(new URL('public/ai/app.js', root), 'utf8')
const html = readFileSync(new URL('public/ai/index.html', root), 'utf8')
const css = readFileSync(new URL('public/ai/styles.css', root), 'utf8')
const responsive = readFileSync(new URL('public/ai/responsive.css', root), 'utf8')

function block(startMarker, endMarker) {
  const start = app.indexOf(startMarker)
  const end = app.indexOf(endMarker, start)
  expect(start).toBeGreaterThanOrEqual(0)
  expect(end).toBeGreaterThan(start)
  return app.slice(start, end)
}

describe('manual trade review frontend contract', () => {
  it('gates the third subtab and keeps the three stages in one workspace', () => {
    expect(html).toContain('data-workspace-target="manual-trades"')
    expect(html).toContain('admin-only platform-content-only manual-trade-review-tab')
    expect(html).toContain('data-manual-stage="selection"')
    expect(html).toContain('data-manual-stage="strategy"')
    expect(html).toContain('data-manual-stage="result"')
    expect(html).toContain('用户陈述 · 你的下单逻辑（非证据）')
    expect(app).toContain('canManagePlatformAiContent()')
  })

  it('loads the selector on demand with the cursor and frozen snapshot contract', () => {
    const query = block('function manualTradeReviewQuery', 'function manualTradeReviewResetCursor')
    expect(query).toContain('/api/ai/manual-trade-reviews/eligible-trades?')
    expect(query).toContain('force_refresh')
    expect(query).toContain('range_start_utc_msc')
    expect(query).toContain('range_end_utc_msc')
    const loader = block('async function loadManualTradeReviewTrades', 'async function moveManualTradeReviewCursor')
    expect(loader).toContain('cursor')
    expect(loader).toContain('history_snapshot_id')
    expect(loader).toContain('state.manualTradeReviewRequestVersion')
    const workspace = block('async function loadManualTradeReviewWorkspace', 'function manualTradeReviewBuildClientRequestId')
    expect(workspace).toContain('loadManualTradeReviewTrades')
    expect(workspace).toContain('!state.manualTradeReviewLoaded')
  })

  it('explains bounded empty-page scans instead of showing an empty list with a dead next page', () => {
    const loader = block('async function loadManualTradeReviewTrades', 'async function moveManualTradeReviewCursor')
    const rendering = block('function renderManualTradeReviewTrades', 'function renderManualTradeReviewPager')
    const pager = block('function renderManualTradeReviewPager', 'async function loadManualTradeReviewTrades')
    expect(loader).toContain('scanned_source_pages')
    expect(loader).toContain('skipped_empty_source_pages')
    expect(loader).toContain('data.unavailable')
    expect(rendering).toContain('手动交易证据不可用')
    expect(rendering).toContain('已检查当前范围，仍有更早记录')
    expect(rendering).toContain('最近 7 天没有可复盘交易')
    expect(pager).toContain('继续查找')
    expect(pager).toContain('!state.manualTradeReviewHasMore')
  })

  it('shows the explicit MT4 terminal-visible history boundary instead of a generic execution error', () => {
    const rendering = block('function renderManualTradeReviewTrades', 'function renderManualTradeReviewPager')
    expect(app).toContain('manual_trade_review_mt4_visible_history_incomplete')
    expect(app).toContain('manual_trade_review_mt4_visible_history_unknown')
    expect(app).toContain('history_cursor_range_incomplete')
    expect(rendering).toContain('manualTradeReviewHistorySourceLimited')
    expect(rendering).toContain('账户历史')
    expect(rendering).toContain('全部历史')
    expect(rendering).toContain('不会宣称券商全量历史')
  })

  it('keeps review confirmation separate and removes experience candidate creation', () => {
    const create = block('async function createManualTradeReviewTask', 'function manualTradeReviewCaseStatus')
    expect(create).not.toContain('experience-candidates')
    const handler = block('if (manualReviewAction)', 'if (reviewCase)')
    expect(handler).not.toContain('candidate_ids:candidateIds')
    expect(handler).not.toContain('experience-candidates')
    expect(app).toContain('未写入经验或策略')
    expect(app).toContain('manual-trade-review-v2')
    expect(app).toContain('不会自动填充或保存')
    const strategyEditor = block('async function openManualReviewStrategyEditor', 'async function saveUserFeatureFlags')
    expect(strategyEditor).toContain('await loadStrategyCatalog()')
    expect(strategyEditor).toContain('Number(item.id) === strategyId')
    expect(strategyEditor).toContain('openStrategyEditor(strategy)')
    expect(strategyEditor).not.toContain('openStrategyEditor(null)')
  })

  it('ships a cache key and mobile controls with a 44px touch target', () => {
    expect(html).toContain('20260812memory4')
    expect(html).toContain('manualmt4history1')
    expect(css).toContain('.manual-review-trade-row')
    expect(responsive).toContain('.manual-review-filter-bar .btn')
    expect(responsive).toContain('min-height: 44px')
  })
})
