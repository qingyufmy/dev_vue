import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { verifyPaymentMatchProof } from '../scripts/lib/inplace-payment-match-proof.mjs'
import { loadPaymentMatchCoordinator } from '../scripts/lib/inplace-payment-match-schema.mjs'

const root = new URL('../', import.meta.url)
const json = async name => JSON.parse(await readFile(new URL(`docs/migration/${name}`, root), 'utf8'))
const proof = await json('dev-vue-payment-match-rehearsal-20260907.json')
const backup = await json('dev-vue-inplace-backup-20260906.json')
const columns = await json('dev-vue-inplace-column-rehearsal-20260906.json')
const plan = await loadPaymentMatchCoordinator(root)

describe('referral coordinator physical rehearsal evidence gate', () => {
  it('accepts the actual rehearsal only with matching tools and source evidence', async () => {
    expect(await verifyPaymentMatchProof(root, proof, backup, columns, plan)).toMatchObject({ toolsVerified: 130 })
  })
  it.each([
    p => { p.ledgerRowsPreserved = 0 },
    p => { p.ledgerHash = 'invalid' },
    p => { p.paymentOrderRowsPreserved = 1 },
    p => { p.orderHash = 'invalid' },
    p => { p.serverUuid = 'another-instance' },
    p => { p.backupSnapshotId = 'another-backup' },
    p => { p.steps[0].checksum = 'changed' },
    p => { p.recoveries.pop() },
    p => { p.originalParityHash = 'changed' },
    p => { p.repeated.steps[0].status = 'applied' },
    p => { p.toolManifest.pop() },
    p => { p.toolManifest[0].path = '../server/.env' },
    p => { p.toolManifest[0].sha256 = '0'.repeat(64) },
    p => { p.toolManifest[0] = p.toolManifest[1] },
  ])('rejects incomplete or modified evidence %#', async mutate => {
    const changed = structuredClone(proof); mutate(changed)
    await expect(verifyPaymentMatchProof(root, changed, backup, columns, plan)).rejects.toThrow('inplace_coordinator_')
  })
})
