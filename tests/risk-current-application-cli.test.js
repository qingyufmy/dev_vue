import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { freezeRiskStructureTools } from '../scripts/lib/mysql-risk-structure-store.mjs'

test('application entry rejects missing proof and non-apply modes before reading credentials', () => {
  for (const args of [[], ['--inspect-only', 'a'.repeat(64), 'D:/unused.json'], ['--apply', 'bad', 'D:/unused.json']]) {
    const result = spawnSync(process.execPath, ['scripts/apply-risk-current-upgrade-local.mjs', ...args],
      { cwd: new URL('../', import.meta.url), input: '', encoding: 'utf8', timeout: 5000 })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /AssertionError/)
    assert.equal(result.stdout, '')
  }
})

test('proof tool inventory includes both actual application entrypoints', async () => {
  const root = new URL('../', import.meta.url)
  const tools = await freezeRiskStructureTools(root)
  for (const path of ['scripts/apply-risk-current-upgrade-local.mjs', 'scripts/run-risk-current-application-local.py']) {
    assert.equal(tools.filter(item => item.path === path).length, 1)
    assert.ok((await readFile(new URL(path, root))).length > 0)
  }
})
