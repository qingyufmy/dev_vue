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

  it('keeps repository guidelines aligned with the V4 source layout and toolchain', () => {
    const guidelines = readFileSync(new URL('AGENTS.md', root), 'utf8')
    const normalizedGuidelines = guidelines.replaceAll('\\', '/')
    for (const expected of [
      'server/src/',
      'frontend/apps/www',
      'frontend/apps/trade',
      'frontend/apps/admin',
      'frontend/apps/auth',
      'frontend/packages/ui',
      'ecosystem.v4.config.cjs',
      'bridge/prototypes/net48-win7/test.ps1',
    ]) expect(normalizedGuidelines).toContain(expected)
    for (const obsolete of [
      'server/modules/',
      'ecosystem.config.cjs',
      'scripts/bridge-native/test-native.ps1',
      '%APPDATA%/AURUM/BridgeV3',
      '/account/?embed=',
    ]) expect(normalizedGuidelines).not.toContain(obsolete)
  })
})
