import { describe, expect, it } from 'vitest'

import {
  buildStrategyMemorySourceManifest,
  extractStrategyMemorySemanticAnchors,
  validateStrategyMemoryCompressionOutput,
} from '../../server/routes/ai/strategy-memory-semantics.js'
import { buildStrategyMemoryCompressionMessages } from '../../server/routes/ai/strategy-memory-compression.js'

function response(manifest, content, overrides = {}) {
  const { resultSection = '压缩后的规则', disposition = 'preserved', ...extra } = overrides
  return {
    content_text:content,
    coverage_map:manifest.source_blocks.map(block => ({
      source_block_id:block.id, result_section:resultSection, disposition,
    })),
    unresolved_conflicts:[], removed_redundancies:[], ...extra,
  }
}

describe('strategy memory semantic manifest and validator', () => {
  it('groups a heading with its paragraphs and list instead of splitting every line', () => {
    const manifest = buildStrategyMemorySourceManifest({ content_text:'## 风险边界\n\n- 仅在 M15 做多 XAUUSD\n- 风险不得超过 1.5%' })
    expect(manifest.source_blocks).toHaveLength(1)
    expect(manifest.source_blocks[0].hash).toMatch(/^[a-f0-9]{64}$/)
    expect(manifest.source_blocks[0].id).toMatch(/^[a-f0-9]{64}$/)
    expect(manifest.source_blocks[0].anchors).toMatchObject({
      percentages:['1.5%'], timeframes:['M15'], directions:['多'], symbols:['XAUUSD'],
    })
    expect(manifest.source_blocks[0].anchors.numbers).not.toContain('1')
  })

  it('allows equivalent duplicate blocks to merge while keeping a complete coverage map', () => {
    const source = '仅在 M15 做多 XAUUSD，风险不得超过 1.5%。\n\n仅在 M15 做多 XAUUSD，风险不得超过 1.5%。'
    const manifest = buildStrategyMemorySourceManifest({ content_text:source })
    expect(manifest.source_blocks).toHaveLength(2)
    const output = {
      content_text:'## 压缩后的规则\n仅在 M15 做多 XAUUSD，风险不得超过 1.5%。',
      coverage_map:manifest.source_blocks.map(block => ({ source_block_id:block.id,
        result_section:'## 压缩后的规则\n仅在 M15 做多 XAUUSD，风险不得超过 1.5%。', disposition:'merged_duplicate' })),
      unresolved_conflicts:[], removed_redundancies:['等价重复'],
    }
    expect(validateStrategyMemoryCompressionOutput({ output, sourceManifest:manifest, targetChars:200 }).ok).toBe(true)
  })

  it('accepts an exact, already concise noop without requiring a ratio', () => {
    const source = '## 精炼规则\n- 止损 20 点，禁止追单。'
    const manifest = buildStrategyMemorySourceManifest({ content_text:source })
    const output = response(manifest, source, { resultSection:source })
    expect(validateStrategyMemoryCompressionOutput({ output, sourceManifest:manifest, targetChars:200 }).ok).toBe(true)
  })

  it.each([
    ['missing source block', manifest => response(manifest, '## 压缩后的规则', { coverage_map:[] }), 'coverage_invalid'],
    ['unknown source block', manifest => response(manifest, '## 压缩后的规则', {
      coverage_map:[{ source_block_id:'f'.repeat(64), result_section:'压缩后的规则', disposition:'preserved' }],
    }), 'coverage_invalid'],
    ['malformed schema', manifest => ({ content_text:'## 压缩后的规则' }), 'output_invalid'],
  ])('rejects %s with a stable validation code', (_name, makeOutput, code) => {
    const manifest = buildStrategyMemorySourceManifest({ content_text:'## 规则\n- 保留 M15。' })
    expect(() => validateStrategyMemoryCompressionOutput({ output:makeOutput(manifest), sourceManifest:manifest, targetChars:200 }))
      .toThrow(`strategy_memory_compression_${code}`)
  })

  it.each([
    ['changed numeric value', '## 规则\n- 风险不得超过 2%', '1%'],
    ['removed negation', '## 规则\n- 风险不超过 1%', '不得'],
    ['removed counterexample', '## 规则\n- 风险不得超过 1%', '反例'],
    ['removed conflict marker', '## 规则\n- 风险不得超过 1%', '冲突'],
    ['added numeric value', '## 规则\n- 风险不得超过 1%，最多 2 次。', '2'],
    ['added timeframe', '## 规则\n- M15/H1 风险不得超过 1%。', 'H1'],
    ['added direction', '## 规则\n- M15 做空/做多 风险不得超过 1%。', '空'],
    ['added symbol', '## 规则\n- M15 做多 XAUUSD/EURUSD，风险不得超过 1%。', 'EURUSD'],
  ])('rejects %s as a semantic anchor mismatch', (_name, content, _anchor) => {
    const source = '## 规则\n- M15 做多 XAUUSD，风险不得超过 1%。\n- 反例与冲突必须保留。'
    const manifest = buildStrategyMemorySourceManifest({ content_text:source })
    const output = response(manifest, content, { resultSection:'规则' })
    expect(() => validateStrategyMemoryCompressionOutput({ output, sourceManifest:manifest, targetChars:300 }))
      .toThrow('strategy_memory_compression_semantic_anchor_mismatch')
  })

  it('rejects a response over target and an applicability/migration residue', () => {
    const source = '## 规则\n- M15 做多，风险不得超过 1%。'
    const manifest = buildStrategyMemorySourceManifest({ content_text:source })
    const longOutput = response(manifest, `## 规则\n${'x'.repeat(100)}`, { resultSection:'规则' })
    expect(() => validateStrategyMemoryCompressionOutput({ output:longOutput, sourceManifest:manifest, targetChars:20 }))
      .toThrow('strategy_memory_compression_output_exceeds_target')
    const residue = response(manifest, '## 规则\n- M15 做多，风险不得超过 1%。\n```json\n{"applicable_when":true}\n```', { resultSection:'规则' })
    expect(() => validateStrategyMemoryCompressionOutput({ output:residue, sourceManifest:manifest, targetChars:200 }))
      .toThrow('strategy_memory_compression_semantic_anchor_mismatch')
  })

  it('rejects swapping numeric/timeframe associations between covered blocks', () => {
    const source = '## M15 规则\n- M15 做多 XAUUSD，风险不得超过 1%。\n\n## H1 规则\n- H1 做空 EURUSD，风险不得超过 2%。'
    const manifest = buildStrategyMemorySourceManifest({ content_text:source })
    const outputText = '## M15 规则\n- H1 做空 EURUSD，风险不得超过 2%。\n\n## H1 规则\n- M15 做多 XAUUSD，风险不得超过 1%。'
    const output = {
      content_text:outputText,
      coverage_map:[
        { source_block_id:manifest.source_blocks[0].id,
          result_section:'## M15 规则\n- H1 做空 EURUSD，风险不得超过 2%。', disposition:'preserved' },
        { source_block_id:manifest.source_blocks[1].id,
          result_section:'## H1 规则\n- M15 做多 XAUUSD，风险不得超过 1%。', disposition:'preserved' },
      ],
      unresolved_conflicts:[], removed_redundancies:[],
    }
    expect(() => validateStrategyMemoryCompressionOutput({ output, sourceManifest:manifest, targetChars:300 }))
      .toThrow('strategy_memory_compression_semantic_anchor_mismatch')
  })

  it('keeps capacity pending updates out of the model prompt unless explicitly included', () => {
    const pending = [{ id:7, update_kind:'daily_review', content_text:'待整理的 M5 反例' }]
    const base = { strategy:{ id:1, title:'策略', version:1 }, strategyText:'只做顺势',
      library:{ version_no:2, content_hash:'a'.repeat(64), content_text:'## 当前规则\n- M15 做多。' },
      pendingUpdates:pending, pendingIds:[7], targetChars:200 }
    const excluded = JSON.parse(buildStrategyMemoryCompressionMessages({ ...base, includePendingUpdates:false })[1].content)
    expect(excluded.frozen_pending_updates).toEqual({ ids:[], updates:[] })
    expect(excluded.semantic_manifest.source_blocks).toHaveLength(1)
    expect(excluded.semantic_manifest.source_blocks[0].text).not.toContain('待整理')

    const included = JSON.parse(buildStrategyMemoryCompressionMessages({ ...base, includePendingUpdates:true })[1].content)
    expect(included.frozen_pending_updates.updates[0].content_text).toContain('待整理')
    expect(included.semantic_manifest.source_blocks).toHaveLength(2)

    const collisionManifest = buildStrategyMemorySourceManifest({ content_text:'同一规则 M15',
      pendingUpdates:[{ id:7, content_text:'同一规则 M15' }], includePendingUpdates:true })
    expect(new Set(collisionManifest.source_block_ids).size).toBe(2)
  })

  it('does not treat Markdown list or title numbering as business numbers', () => {
    const anchors = extractStrategyMemorySemanticAnchors('## 12. 规则\n1. M15 做多\n2. 风险不得超过 1%')
    expect(anchors.numbers).toEqual(['1%'])
  })
})
