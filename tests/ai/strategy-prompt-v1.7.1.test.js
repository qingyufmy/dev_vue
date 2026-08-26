import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const prompt = readFileSync(new URL('../../docs/行情分析Agent-v1.7.1-完整提示词.md', import.meta.url), 'utf8')

describe('行情分析 Agent v1.7.1 prompt contract', () => {
  it('keeps the original multi-timeframe workflow and restores six M15 candidates', () => {
    expect(prompt).toContain('1H趋势主判')
    expect(prompt).toContain('4H降级备判')
    expect(prompt).toContain('M15-1 缠论背驰')
    expect(prompt).toContain('M15-2 谐波PRZ触达')
    expect(prompt).toContain('M15-3 第一、第二或第三类买卖点')
    expect(prompt).toContain('M15-4 关键裸K')
    expect(prompt).toContain('M15-5 假突破')
    expect(prompt).toContain('M15-6 支撑阻力K线反应')
    expect(prompt).toContain('M15独立通过数量 >= 2')
    expect(prompt).toContain('分母固定为六项')
    expect(prompt).not.toContain('至少2个相互独立的证据组')
    expect(prompt).not.toContain('独立确认数量：[X / 3]')
  })

  it('uses system Chan as the only authority and does not provide a model-side Chan fallback', () => {
    expect(prompt).toContain('系统Chan是唯一缠论权威')
    expect(prompt).toContain('不得根据原始K线重新计算、补算、修正或覆盖分型、笔、线段、中枢、背驰和买卖点')
    expect(prompt).toContain('divergence_usable')
    expect(prompt).toContain('entry_structure_usable')
    expect(prompt).not.toMatch(/顶分型[：:]\s*\n\s*-/)
    expect(prompt).not.toContain('成笔条件')
    expect(prompt).not.toContain('线段至少由3笔构成')
    expect(prompt).not.toContain('连续三笔存在有效价格重叠')
    expect(prompt).not.toContain('MACD面积法')
  })

  it('does not duplicate objective indicator formulas already supplied by the system', () => {
    expect(prompt).toContain('strategy_context.indicators.ema34')
    expect(prompt).toContain('summary.atr_14_closed')
    expect(prompt).not.toMatch(/EMA\d*\s*\(t\)\s*=/i)
    expect(prompt).not.toMatch(/TR\s*\(t\)\s*=/i)
    expect(prompt).not.toMatch(/DIF\s*\(t\)\s*=/i)
    expect(prompt).not.toMatch(/DEA\s*\(t\)\s*=/i)
    expect(prompt).not.toMatch(/Pivot\s*=/i)
    expect(prompt).not.toContain('系统提供客观数据时不要复算')
  })

  it('keeps PRZ optional, preserves M5 and EMA gates, and enforces net reward-to-risk', () => {
    expect(prompt).toContain('PRZ不是必要条件')
    expect(prompt).toContain('M5至少一项已收盘触发')
    expect(prompt).toContain('M1 EMA34证据可用且方向通过')
    expect(prompt).toContain('推荐执行档位净风险收益至少1:1.5')
    expect(prompt).toContain('不建仓`、`试探仓`、`轻仓`、`标准仓')
    expect(prompt).not.toMatch(/\b0\.0[1-9]\s*手/)
  })

  it('requires the auditable reasoning prefix and evidence-level deduplication', () => {
    for (const marker of [
      'H1=[通过/不明确/不可用]',
      'M15-1背驰=[通过/未通过/不可用/未检查]',
      'M15-2PRZ=[通过/未通过/不可用/未检查]',
      'M15-3买卖点=[通过/未通过/不可用/未检查]',
      'M15-4裸K=[通过/未通过/不可用/未检查]',
      'M15-5假突破=[通过/未通过/不可用/未检查]',
      'M15-6关键位反应=[通过/未通过/不可用/未检查]',
      'M15独立通过数=[0-6]',
    ]) expect(prompt).toContain(marker)
    expect(prompt).toContain('同一底层证据不得换名称重复计票')
  })
})
