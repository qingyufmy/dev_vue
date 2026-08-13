import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import crypto from 'node:crypto'
import {
  renderStrategyMemoryMarkdown,
  renderStrategyMemoryMarkdownPreview,
  STRATEGY_MEMORY_MARKDOWN_RENDER_SCHEMA_VERSION,
} from '../../server/routes/ai/strategy-memory-markdown.js'
import { buildStrategyMemorySourceManifest, splitStrategyMemoryMarkdownBlocks } from '../../server/routes/ai/strategy-memory-semantics.js'

const source = readFileSync(new URL('../../server/migrations.js', import.meta.url), 'utf8')

describe('strategy memory Markdown preview contract', () => {
  it('renders supported Markdown and never passes raw HTML through', () => {
    const preview = renderStrategyMemoryMarkdownPreview({ content_text:[
      '# 核心规则',
      '',
      '遵守 **风险边界**、*确认条件* 和 ~~废弃规则~~。',
      '',
      '- 等待确认',
      '- 设置止损',
      '',
      '> 这是人工复核提示。',
      '',
      '[安全文档](https://example.com/guide)',
      '',
      '<script>alert(1)</script><img src=x onerror=alert(2)>',
      '',
      '```js',
      '<script>alert(3)</script>',
      '```',
    ].join('\n') })

    expect(preview.render_schema_version).toBe(STRATEGY_MEMORY_MARKDOWN_RENDER_SCHEMA_VERSION)
    // A heading anchors the rest of its section as one logical block; the
    // renderer still emits each nested Markdown construct inside that block.
    expect(preview.blocks).toHaveLength(1)
    expect(preview.preview_html).toContain('<h1>核心规则</h1>')
    expect(preview.preview_html).toContain('<strong>风险边界</strong>')
    expect(preview.preview_html).toContain('<ul><li>等待确认</li><li>设置止损</li></ul>')
    expect(preview.preview_html).toContain('<blockquote><p>这是人工复核提示。</p></blockquote>')
    expect(preview.preview_html).toContain('href="https://example.com/guide"')
    expect(preview.preview_html).not.toContain('<script')
    expect(preview.preview_html).not.toContain('<img')
    expect(preview.preview_html).not.toMatch(/<[^>]*\bonerror\s*=/iu)
    expect(preview.preview_html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(preview.preview_html).toContain('&lt;script&gt;alert(3)&lt;/script&gt;')
  })

  it('drops dangerous destinations instead of emitting protocol-bearing links', () => {
    const preview = renderStrategyMemoryMarkdown({ content_text:[
      '[脚本](javascript:alert(1))',
      '[数据](data:text/html,alert(2))',
      '[文件](file:///tmp/a)',
      '[协议相对](//evil.example/x)',
      '[安全](mailto:review@example.com)',
    ].join('\n\n') })
    expect(preview.preview_html).toContain('脚本')
    expect(preview.preview_html).toContain('数据')
    expect(preview.preview_html).toContain('文件')
    expect(preview.preview_html).toContain('协议相对')
    expect(preview.preview_html).not.toContain('href="javascript:')
    expect(preview.preview_html).not.toContain('href="data:')
    expect(preview.preview_html).not.toContain('href="file:')
    expect(preview.preview_html).not.toContain('javascript:')
    expect(preview.preview_html).not.toContain('data:text')
    expect(preview.preview_html).toContain('href="mailto:review@example.com"')
  })

  it('keeps block identity, ordering and hashes stable across line endings', () => {
    const content = '# 规则\n\n- 只做多头\n- 设置 1% 止损\n\n## 例外\n\n出现反例时暂停'
    const windows = renderStrategyMemoryMarkdownPreview({ content_text:content })
    const unix = renderStrategyMemoryMarkdownPreview({ content_text:content.replaceAll('\n', '\r\n') })
    expect(unix.content_hash).toBe(windows.content_hash)
    expect(unix.blocks.map(block => [block.block_id, block.block_hash, block.order, block.text]))
      .toEqual(windows.blocks.map(block => [block.block_id, block.block_hash, block.order, block.text]))
    expect(unix.preview_html).toBe(windows.preview_html)
    expect(splitStrategyMemoryMarkdownBlocks(content)).toEqual(windows.blocks.map(block => block.text))
    expect(buildStrategyMemorySourceManifest({ content_text:content }).source_block_ids)
      .toEqual(windows.blocks.map(block => block.block_id))
  })

  it('returns a deterministic empty result and library-compatible hash', () => {
    const preview = renderStrategyMemoryMarkdownPreview({ content_text:'' })
    expect(preview).toEqual({
      render_schema_version:1,
      preview_html:'',
      blocks:[],
      content_hash:crypto.createHash('sha256').update('', 'utf8').digest('hex'),
    })
  })
})

describe('strategy memory preview migration 183 contract', () => {
  it('adds bindings, frozen consistency snapshots and independent feature flags', () => {
    expect(source).toContain("id: '183_strategy_memory_conflict_bindings_and_checks'")
    expect(source).toContain('CREATE TABLE IF NOT EXISTS strategy_memory_conflict_bindings')
    expect(source).toContain('CREATE TABLE IF NOT EXISTS strategy_memory_consistency_jobs')
    for (const field of [
      'identity_version', 'conflict_kind', 'strategy_rule_hash', 'canonical_lineage_key',
      'detection_count', 'verification_status', 'last_detected_at', 'last_validated_at',
      'binding_id', 'memory_block_id', 'memory_block_hash', 'memory_excerpt',
      'strategy_content_hash', 'strategy_text_snapshot', 'memory_content_snapshot',
      'detector_contract_version', 'result_json',
    ]) expect(source).toContain(field)
    expect(source).toContain('strategy_memory_markdown_preview_enabled')
    expect(source).toContain('strategy_memory_consistency_checks_enabled')
    expect(source).toContain('UNIQUE KEY uk_strategy_memory_binding_snapshot')
    expect(source).toContain('UNIQUE KEY uk_strategy_memory_consistency_input')
    expect(source).toContain('CREATE TABLE IF NOT EXISTS')
    expect(source).toContain('information_schema.COLUMNS')
    expect(source).toContain('information_schema.STATISTICS')
  })

  it('does not replace the already deployed 181/182 migration bodies', () => {
    const first183 = source.indexOf("id: '183_strategy_memory_conflict_bindings_and_checks'")
    expect(first183).toBeGreaterThan(source.indexOf("id: '182_strategy_memory_merge_integrity'"))
    expect(source.slice(0, first183)).toContain("id: '181_unified_strategy_memory_library'")
    expect(source.slice(0, first183)).toContain("id: '182_strategy_memory_merge_integrity'")
  })
})
