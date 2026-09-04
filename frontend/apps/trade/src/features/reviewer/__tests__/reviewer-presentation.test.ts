import { describe, expect, it } from 'vitest'
import {
  mapManualReviewCandidate,
  mapReviewCaseDetail,
  mapReviewCaseSummary,
  mapStrategyMemoryDetail,
  formatTerminalTimezoneOffset,
  reviewContentForVersion,
} from '../model/reviewer-presentation'

describe('reviewer presentation adapters', () => {
  it('maps the typed V4 case summary into terminal-period and account labels', () => {
    const summary = mapReviewCaseSummary({
      id: 'case-1',
      kind: 'daily',
      userId: 'user-1',
      tradingAccountId: 'account-1',
      accountLabel: 'MT5 · 596520',
      symbol: 'XAUUSD',
      subscriptionId: 'subscription-1',
      subscriptionRevision: 4,
      analysisStrategyId: 'strategy-1',
      analysisStrategyName: '趋势分析',
      traderStrategyId: null,
      traderStrategyName: null,
      terminalPeriodStart: '2026-09-04T00:00:00.000+08:00',
      terminalPeriodEnd: '2026-09-05T00:00:00.000+08:00',
      terminalTimezoneOffsetMinutes: 480,
      status: 'awaiting_confirmation',
      evidenceStatus: 'complete',
      evidenceRevision: 2,
      evidenceHash: 'b'.repeat(64),
      currentVersionId: 'version-1',
      confirmedVersionId: null,
      updatedAt: '2026-09-04T12:00:00.000+08:00',
      revision: 3,
    })

    expect(summary).toMatchObject({
      id: 'case-1',
      accountId: 'account-1',
      accountLabel: 'MT5 · 596520',
      subscriptionId: 'subscription-1',
      subscriptionRevision: 4,
      terminalPeriod: '2026-09-04',
      strategyLabel: '趋势分析',
      status: 'awaiting_confirmation',
      currentVersionId: 'version-1',
      revision: 3,
    })
  })

  it('preserves typed detail evidence, episodes, roles, and full text', () => {
    const detail = mapReviewCaseDetail({
      summary: {
        id: 'case-2',
        kind: 'manual',
        userId: 'user-1',
        tradingAccountId: 'account-1',
      accountLabel: 'MT4 · 123456',
      symbol: 'XAUUSD',
      subscriptionId: null,
      subscriptionRevision: null,
      analysisStrategyId: null,
        analysisStrategyName: null,
        traderStrategyId: null,
        traderStrategyName: null,
        terminalPeriodStart: '2026-09-04T00:00:00.000+08:00',
        terminalPeriodEnd: '2026-09-05T00:00:00.000+08:00',
        terminalTimezoneOffsetMinutes: 480,
        status: 'confirmed',
        evidenceStatus: 'complete',
        evidenceRevision: 1,
        evidenceHash: 'c'.repeat(64),
        currentVersionId: 'version-2',
        confirmedVersionId: 'version-2',
        updatedAt: '2026-09-04T13:00:00.000+08:00',
        revision: 4,
      },
      currentVersion: {
        id: 'version-2',
        caseId: 'case-2',
        versionNumber: 2,
        authorKind: 'ai',
        conclusion: 'mixed',
        content: {
          schemaVersion: 'review.v4.1',
          conclusion: 'mixed',
          headline: '人工交易复盘',
          summary: '保留风险边界。',
          metrics: { netProfit: '-12.50', tradeCount: 1, winRatePercent: '0', profitFactor: null },
          tradeEpisodes: [{ sourceId: 'ticket-1', symbol: 'XAUUSD', side: 'sell', openedAt: null, closedAt: null, netProfit: '-12.50', outcome: 'loss', summary: '止损离场' }],
          roles: {
            analyst: { assessment: 'mixed', summary: '行情判断部分有效。', evidenceRefs: ['analysis-1'] },
            trader: { assessment: 'effective', summary: '执行符合计划。', evidenceRefs: ['trade-1'] },
            risk: { assessment: 'effective', summary: '风险参数完整。', evidenceRefs: ['risk-1'] },
            execution: { assessment: 'effective', summary: '终端回执完整。', evidenceRefs: ['execution-1'] },
          },
          counterexamples: [{ kind: 'false_positive', title: '追价风险', summary: '未等待确认。', evidenceRefs: ['quote-1'], status: 'candidate' }],
          memoryCandidates: [{ strategyId: 'strategy-1', memoryKey: 'strategy-1', updateKind: 'short_term', title: '等待确认', content: '减少追价。', evidenceRefs: ['trade-1'] }],
          evidenceRefs: ['analysis-1', 'trade-1'],
          fullAnalysisText: '完整模型正文保留在最底部。',
        },
        createdAt: '2026-09-04T13:00:00.000+08:00',
      },
      sources: [{ kind: 'execution_outcome', sourceId: 'execution-1', relation: 'direct', evidenceHash: 'a'.repeat(64) }],
      currentJob: null,
      returnReason: null,
    })

    expect(detail).toMatchObject({
      id: 'case-2',
      title: '人工交易复盘',
      conclusion: '保留风险边界。',
      fullText: '完整模型正文保留在最底部。',
      evidenceHash: 'c'.repeat(64),
      evidence: [{ sourceId: 'execution-1', complete: true }],
      episodes: [{ id: 'ticket-1', direction: '卖出', outcome: '亏损', profit: '-12.50' }],
      memoryCandidates: [{ strategyId: 'strategy-1', updateKind: 'short_term' }],
    })
    expect(detail.layers.map((layer) => layer.status)).toEqual(['部分有效', '有效', '有效', '有效'])
    expect(detail.layers.map((layer) => layer.label)).toEqual(['AI 分析师', 'AI 交易员', '硬风控', '终端执行'])
  })

  it('blocks already-reviewed manual trades and refuses to fabricate an editable review body', () => {
    const candidate = mapManualReviewCandidate({
      id: 'candidate-1',
      tradingAccountId: 'account-1',
      accountLabel: 'MT5 · 596520',
      ticket: 'ticket-1',
      positionId: null,
      symbol: 'XAUUSD',
      side: 'buy',
      volume: '0.10',
      openedAt: '2026-09-04T08:00:00.000+08:00',
      closedAt: '2026-09-04T09:00:00.000+08:00',
      netProfit: '5.00',
      terminalTimezoneOffsetMinutes: 480,
      sourceClassification: 'manual',
      eligibilityStatus: 'already_reviewed',
      selectionToken: 'token-token-token-token-token',
      selectionExpiresAt: '2026-09-04T10:00:00.000+08:00',
      revision: 1,
    })

    expect(candidate).toMatchObject({
      direction: '买入',
      sourceStatus: '人工交易 · 已复盘',
      canReview: false,
      ticket: 'ticket-1',
      terminalTimezoneOffsetMinutes: 480,
    })
    expect(formatTerminalTimezoneOffset(candidate.terminalTimezoneOffsetMinutes)).toBe('UTC+08:00')

    const detail = mapReviewCaseDetail({
      summary: {
        id: 'case-3', kind: 'manual', userId: 'user-1', tradingAccountId: 'account-1', accountLabel: 'MT5 · 596520',
        symbol: 'XAUUSD', subscriptionId: null, subscriptionRevision: null, analysisStrategyId: null, analysisStrategyName: null, traderStrategyId: null, traderStrategyName: null,
        terminalPeriodStart: '2026-09-04T00:00:00.000+08:00', terminalPeriodEnd: '2026-09-05T00:00:00.000+08:00', terminalTimezoneOffsetMinutes: 480,
        status: 'confirmed', evidenceStatus: 'complete', evidenceRevision: 1, evidenceHash: null, currentVersionId: null, confirmedVersionId: null,
        updatedAt: '2026-09-04T13:00:00.000+08:00', revision: 1,
      },
      currentVersion: null, sources: [], currentJob: null, returnReason: null,
    })
    expect(() => reviewContentForVersion(detail, '人工补充复盘正文')).toThrow('当前复核没有可编辑的结构化版本')
  })

  it('maps strategy memory detail content and immutable version metadata', () => {
    const memory = mapStrategyMemoryDetail({
      id: 'memory-1', strategyId: 'strategy-1', strategyName: '趋势分析', strategyKind: 'analysis', ownerUserId: 'user-1',
      mode: 'active', status: 'active', currentVersionNumber: 3, pendingCount: 1,
      updatedAt: '2026-09-04T13:00:00.000+08:00', revision: 8, currentRevisionId: 'memory-version-3',
      contentText: '确认后的经验正文。', contentHash: null, maxContextTokens: 4000,
    })

    expect(memory).toMatchObject({ id: 'memory-1', strategyLabel: '趋势分析', version: 3, status: '生效中', content: '确认后的经验正文。' })
  })
})
