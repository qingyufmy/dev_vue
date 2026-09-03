import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const root = new URL('../', import.meta.url)

describe('repository hygiene', () => {
  it('uses one package manager and does not keep generated test logs in source control', () => {
    expect(existsSync(new URL('package-lock.json', root))).toBe(false)
    expect(existsSync(new URL('pnpm-lock.yaml', root))).toBe(true)
    expect(existsSync(new URL('pnpm-workspace.yaml', root))).toBe(true)
    expect(existsSync(new URL('test_output.txt', root))).toBe(false)
    expect(existsSync(new URL('test_stderr.txt', root))).toBe(false)

    const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
    expect(pkg.packageManager).toMatch(/^pnpm@/)
  })

  it('keeps Bridge startup independent from the heavyweight AI scheduler and config modules', () => {
    const bridge = readFileSync(new URL('server/bridge-ws.js', root), 'utf8')
    expect(bridge).not.toMatch(/^import .*routes\/ai\/scheduler\.js/m)
    expect(bridge).not.toMatch(/^import .*routes\/ai\/config\.js/m)
    expect(bridge).toContain("from './routes/ai/runtime-state-registry.js'")
  })
})
