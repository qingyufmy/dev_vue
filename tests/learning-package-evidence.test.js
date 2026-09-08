import { expect, it } from 'vitest'
import { assertLearningPackageCompatibility, verifyLearningPackageEvidence } from '../scripts/lib/learning-package-evidence.mjs'

const original = { type: 'module', engines: { node: '>=22.12.0' }, packageManager: 'pnpm@11.19.0',
  scripts: { test: 'vitest run' }, dependencies: { mysql2: '^3.23.1' }, devDependencies: { vitest: '^3.2.7' } }

it('accepts independent script and additive dependency changes', () => {
  const current = structuredClone(original)
  current.scripts.test = 'pnpm run verify:architecture && vitest run'
  current.dependencies.ajv = '8.20.0'
  current.devDependencies['openapi-typescript'] = '7.13.0'
  expect(() => assertLearningPackageCompatibility(original, current)).not.toThrow()
})

it.each(['dependency-version', 'dependency-removal', 'dev-version', 'engine', 'manager', 'type', 'overrides'])(
  'rejects changes to previously verified configuration: %s', change => {
    const current = structuredClone(original)
    if (change === 'dependency-version') current.dependencies.mysql2 = '^4.0.0'
    if (change === 'dependency-removal') delete current.dependencies.mysql2
    if (change === 'dev-version') current.devDependencies.vitest = '^4.0.0'
    if (change === 'engine') current.engines.node = '>=18'
    if (change === 'manager') current.packageManager = 'pnpm@12.0.0'
    if (change === 'type') current.type = 'commonjs'
    if (change === 'overrides') current.pnpm = { overrides: { mysql2: '0.0.1' } }
    expect(() => assertLearningPackageCompatibility(original, current)).toThrow('incompatible')
  })

it('verifies archived bytes against the immutable original receipt hash', async () => {
  const root = new URL('../', import.meta.url)
  await expect(verifyLearningPackageEvidence(root, '6a28d132e349a7d7958232e4b3ed156caa268486b5e90d183226b4454ce8d54b')).resolves.toBeUndefined()
  await expect(verifyLearningPackageEvidence(root, '0'.repeat(64))).rejects.toThrow('evidence_changed')
})
