import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { verifyReferralOpeningProof } from '../scripts/lib/referral-opening-proof.mjs'
const root = new URL('../', import.meta.url)
const read = async name => JSON.parse(await readFile(new URL(`docs/migration/${name}`, root), 'utf8'))
const proof = await read('dev-vue-referral-openings-rehearsal-20260907.json')
const repeat = await read('dev-vue-referral-openings-repeat-20260907.json')
const run = await read('dev-vue-referral-backfill-run-20260907.json')
const backup = await read('dev-vue-inplace-backup-20260906.json')
const columns = await read('dev-vue-inplace-column-rehearsal-20260906.json')
it('accepts the exact real rehearsal and independent repetition', async () => {
  expect(await verifyReferralOpeningProof(root, proof, repeat, run, backup, columns)).toMatchObject({ toolsVerified: 132 })
})
it.each([
  p => { p.identity.uuid = 'wrong' },
  p => { p.commitResponseLossInjected = false },
  p => { p.result.balanceUpdates = 1 },
  p => { p.result.existing = 24 },
  p => { p.originalParityHash = 'changed' },
  p => { p.toolManifest.pop() },
  p => { p.runManifestHash = 'changed' },
])('rejects incomplete or altered evidence %#', async mutate => {
  const changed = structuredClone(proof); mutate(changed)
  await expect(verifyReferralOpeningProof(root, changed, repeat, run, backup, columns)).rejects.toThrow('opening_proof_')
})
it('rejects an independently repeated run that inserted data', async () => {
  await expect(verifyReferralOpeningProof(root, proof, { ...repeat, insertions: 1 }, run, backup, columns)).rejects.toThrow('opening_proof_repeat')
})
