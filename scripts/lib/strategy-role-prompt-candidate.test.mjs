import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { hash } from './v4-backfill-contract.mjs'
import { buildStrategyRolePromptCandidate } from './strategy-role-prompt-candidate.mjs'
const source = { id: '3', version: '11', system_prompt: '# Example\n\n## Market\n精确市场规则\n\n## Management\n保留管理规则\n' }
const plan = { sourceHash: hash(source), promptHash: createHash('sha256').update(source.system_prompt).digest('hex'),
  introductions: { analysis: 'Only market evidence.', trader: 'Only account decisions.' }, sections: [
    { index: 0, heading: '# Example', roles: ['analysis', 'trader'] }, { index: 1, heading: '## Market', roles: ['analysis'] },
    { index: 2, heading: '## Management', roles: ['trader'] },
  ] }
test('preserves assigned source bytes and keeps review candidates non-executable', () => {
  const result = buildStrategyRolePromptCandidate(source, plan)
  assert.equal(result.originalTextFullyAssigned, true)
  assert.equal(result.executable, false); assert.equal(result.runtimeAdmission, 'blocked')
  assert.ok(result.roles.analysis.promptText.includes('精确市场规则'))
  assert.ok(!result.roles.analysis.promptText.includes('保留管理规则'))
  assert.ok(result.roles.trader.promptText.includes('保留管理规则'))
  assert.deepEqual(result.roles.trader.sourceSections, [0, 2])
})
test('rejects changed source, incomplete coverage and changed section interpretation', () => {
  assert.throws(() => buildStrategyRolePromptCandidate({ ...source, version: '12' }, plan), { code: 'role_prompt_source_changed' })
  for (const corrupt of [p => p.sections.pop(), p => { p.sections[1].heading = 'changed' }, p => { p.sections[1].index = 2 },
    p => { p.sections[1].roles = [] }, p => { p.sections[1].roles = ['analysis', 'analysis'] }, p => { p.sections[1].roles = ['unknown'] }]) {
    const changed = structuredClone(plan); corrupt(changed)
    assert.throws(() => buildStrategyRolePromptCandidate(source, changed))
  }
})
