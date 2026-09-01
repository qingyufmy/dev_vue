import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const promptPath = path.resolve(
  here,
  '../../docs/行情分析Agent-H1主判-H4降级备判-v3.3反转语义与持仓生命周期修复正式生产版.md',
)
const prompt = fs.readFileSync(promptPath, 'utf8')

describe('H1/H4 production strategy prompt v3.3', () => {
  it('keeps confirmed background separate from a reversal-watch candidate', () => {
    expect(prompt).toContain('confirmed_direction')
    expect(prompt).toContain('trend_state.direction')
    expect(prompt).toContain('`local_bias` 只表示候选反转方向')
    expect(prompt).toContain('M15 只有同向 `local_bias`')
    expect(prompt).not.toContain('方向仍等于 `local_bias`')
    expect(prompt).not.toContain('continuation/reversal_watch` 的方向只来自系统 `local_bias`')
  })

  it('defines generic same-direction position semantics without duplicate open', () => {
    expect(prompt).toContain('position_action=hold_no_add')
    expect(prompt).toContain('position_action=allow_add')
    expect(prompt).toContain('已有同方向持仓时不得再次使用 `position_action=open`')
    expect(prompt).toContain('独立于原事件')
  })

  it('requires a system-provided stop outside the protection boundary', () => {
    expect(prompt).toContain('保护区边界价格本身不等于“方向外侧”')
    expect(prompt).toContain('没有系统提供的合法外侧价格时，必须 `hold/observe`')
    expect(prompt).toContain('不得自行给边界增加固定点数、ATR 倍数、点差或主观缓冲')
  })

  it('defines current-state position exits through platform evaluations', () => {
    expect(prompt).toContain('position_evaluations')
    expect(prompt).toContain('M15 出现与持仓方向相反')
    expect(prompt).toContain('M5 同方向出现 continuation')
    expect(prompt).toContain('同一轮不得同时输出反向新单')
    expect(prompt).toContain('必须原样引用平台本轮字段')
  })

  it('does not ask the model to recompute system objective data', () => {
    expect(prompt).toContain('禁止从原始 K 线重新计算')
    expect(prompt).toContain('不得自行扫描、推导、套公式')
    expect(prompt).toContain('系统提供收益风险结果时只读')
  })
})
