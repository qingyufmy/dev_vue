import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const testDir = dirname(fileURLToPath(import.meta.url))
const aiDir = resolve(testDir, '../../public/ai')
const fonts = readFileSync(resolve(aiDir, 'fonts.css'), 'utf8')
const styles = readFileSync(resolve(aiDir, 'styles.css'), 'utf8')
const html = readFileSync(resolve(aiDir, 'index.html'), 'utf8')

describe('AI frontend static asset contract', () => {
  it('uses native CJK fonts and only four Latin JetBrains declarations', () => {
    expect(fonts).not.toContain("font-family: 'Noto Sans SC'")
    expect(fonts.match(/@font-face/g) || []).toHaveLength(4)
    expect(fonts.match(/font-family:\s*'JetBrains Mono'/g) || []).toHaveLength(4)
    expect([...fonts.matchAll(/font-weight:\s*(\d+)/g)].map(match => Number(match[1])))
      .toEqual([400, 500, 600, 700])

    const urls = [...fonts.matchAll(/url\(([^)]+)\)/g)].map(match => match[1])
    expect(new Set(urls).size).toBeLessThanOrEqual(4)
    for (const url of urls) expect(existsSync(resolve(aiDir, url))).toBe(true)
  })

  it('versions the font stylesheet and keeps Noto web fonts out of the UI stack', () => {
    expect(styles).toMatch(/^@import url\("fonts\.css\?v=20260831fonttraffic1"\);/)
    expect(styles).toContain('--font-display: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", system-ui, sans-serif;')
    expect(styles).toContain('--font-ui: "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", system-ui, sans-serif;')
    expect(styles).not.toContain('--font-ui: "Noto Sans SC"')
    expect(html).toMatch(/\/ai\/styles\.css\?[^"']*fonttraffic1/)
  })
})
