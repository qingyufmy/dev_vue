import { readFile } from 'node:fs/promises'
import { sha256 } from './v4-migration-plan.mjs'

const snapshotPath = 'docs/migration/evidence/learning-schema-package-20260907.json'
const stable = value => JSON.stringify(value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(item => JSON.parse(stable(item)))
    : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(stable(value[key]))]))
  : value)

// Historical manifest bytes are evidence, not the current execution manifest.
// Keep old dependency declarations and all non-script configuration unchanged.
export function assertLearningPackageCompatibility(previous, current) {
  const fail = () => { throw Error('inplace_learning_package_incompatible') }
  for (const value of [previous, current]) if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
  const fixed = value => Object.fromEntries(Object.entries(value).filter(([key]) => !['scripts', 'dependencies', 'devDependencies'].includes(key)))
  if (stable(fixed(previous)) !== stable(fixed(current))) fail()
  for (const section of ['dependencies', 'devDependencies']) {
    for (const value of [previous[section], current[section]]) if (!value || typeof value !== 'object' || Array.isArray(value)) fail()
    for (const [name, version] of Object.entries(previous[section])) if (current[section][name] !== version) fail()
  }
}

export async function verifyLearningPackageEvidence(root, expectedHash) {
  const previous = await readFile(new URL(snapshotPath, root))
  if (sha256(previous) !== expectedHash) throw Error('inplace_learning_package_evidence_changed')
  assertLearningPackageCompatibility(JSON.parse(previous), JSON.parse(await readFile(new URL('package.json', root))))
}
