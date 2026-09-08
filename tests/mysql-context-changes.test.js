import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { loadTradingContextChanges } from '../scripts/lib/inplace-trading-context-changes.mjs'
import { freezeContextChangesTools, prepareContextChangesProof } from '../scripts/lib/mysql-context-changes.mjs'

const root = new URL('../', import.meta.url)
async function fixture() {
  const plan = await loadTradingContextChanges(root)
  const prior = JSON.parse(await readFile(new URL('docs/architecture/legacy-candle-promotion-plan-20260908.json', root)))
  const reference = JSON.parse(await readFile(new URL('docs/architecture/context-receipt-schema-reference-20260908-v2.json', root)))
  const tools = await freezeContextChangesTools(root)
  const history = plan.prior.steps.map(row => ({ id: row.id, checksum: row.checksum, status: 'completed' }))
  const prepare = (patch = {}) => prepareContextChangesProof(plan, patch.identity ?? prior.identity, prior,
    patch.snapshot ?? prior.after, patch.reference ?? reference, patch.tools ?? tools, patch.history ?? history)
  return { prepare, prior, reference, tools, history }
}

it('binds reference DDL, identity, original snapshot, history and tools into the new proof', async () => {
  const f = await fixture(), proof = f.prepare()
  expect(proof.tools).toHaveLength(307)
  expect(proof.priorProofHash).toBe(f.prior.proofHash)
  expect(f.prepare().proofHash).toBe(proof.proofHash)
  expect(f.prepare({ history: [...f.history.slice(0, -1), { ...f.history.at(-1), changed: true }] }).proofHash).not.toBe(proof.proofHash)
})

it('rejects another database identity or a reference from another server/step', async () => {
  const f = await fixture()
  expect(() => f.prepare({ identity: { ...f.prior.identity, database: 'other' } })).toThrow('prior_identity')
  expect(() => f.prepare({ reference: { ...f.reference, identity: { serverUuid: 'other' } } })).toThrow('reference')
  expect(() => f.prepare({ reference: { ...f.reference, stepChecksum: 'wrong' } })).toThrow('reference')
})

it('rejects failed reference evidence, source drift and unexpected prior tables', async () => {
  const f = await fixture()
  expect(() => f.prepare({ reference: { ...f.reference, checks: [] } })).toThrow('reference_checks')
  expect(() => f.prepare({ reference: { ...f.reference, sourceHash: 'wrong' } })).toThrow('reference_tools')
  expect(() => f.prepare({ snapshot: [...f.prior.after, { name: 'unregistered_table' }] })).toThrow('prior_tables')
})
