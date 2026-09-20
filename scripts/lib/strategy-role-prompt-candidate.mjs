import { createHash } from 'node:crypto'
import { hash, requireBackfill as check } from './v4-backfill-contract.mjs'

const digest = value => createHash('sha256').update(value, 'utf8').digest('hex')

/** A review artifact only. Runtime admission and business semantic acceptance are separate. */
export function buildStrategyRolePromptCandidate(source, plan) {
  source = structuredClone(source); plan = structuredClone(plan)
  check(hash(source) === plan.sourceHash && typeof source.system_prompt === 'string'
    && digest(source.system_prompt) === plan.promptHash, 'role_prompt_source_changed')
  const sections = source.system_prompt.split(/(?=^## )/m)
  check(Array.isArray(plan.sections) && sections.length === plan.sections.length, 'role_prompt_section_coverage')
  const reviewed = sections.map((text, index) => {
    const rule = plan.sections[index]
    check(rule.index === index && text.split(/\r?\n/)[0] === rule.heading, 'role_prompt_section_changed')
    check(Array.isArray(rule.roles) && rule.roles.length > 0 && rule.roles.length <= 2
      && new Set(rule.roles).size === rule.roles.length && rule.roles.every(role => ['analysis', 'trader'].includes(role)), 'role_prompt_section_roles')
    return { index, heading: rule.heading, roles: rule.roles, sourceHash: digest(text), bytes: Buffer.byteLength(text), text }
  })
  const roles = Object.fromEntries(['analysis', 'trader'].map(kind => {
    check(typeof plan.introductions?.[kind] === 'string' && plan.introductions[kind].trim(), 'role_prompt_introduction_missing')
    const selected = reviewed.filter(section => section.roles.includes(kind))
    check(selected.length > 0, 'role_prompt_role_empty')
    const promptText = `${plan.introductions[kind]}\n\n${selected.map(section => section.text).join('')}\n\n${plan.introductions[kind]}`
    return [kind, { promptText, promptHash: digest(promptText), bytes: Buffer.byteLength(promptText), sourceSections: selected.map(section => section.index) }]
  }))
  return { kind: 'strategy-role-prompt-review-candidate/v1', sourceHash: plan.sourceHash, sourcePromptHash: plan.promptHash,
    sourceId: source.id, sourceVersion: source.version, roles, sections: reviewed.map(({ text, ...metadata }) => metadata),
    originalTextFullyAssigned: reviewed.map(section => section.text).join('') === source.system_prompt,
    executable: false, semanticAcceptance: 'pending', runtimeAdmission: 'blocked' }
}
