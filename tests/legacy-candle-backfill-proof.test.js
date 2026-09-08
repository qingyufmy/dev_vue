import { expect, it } from 'vitest'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'
import { prepareLegacyCandleBackfillProof, verifyLegacyCandleBackfillProof, freezeLegacyCandleBackfillTools } from '../scripts/lib/legacy-candle-backfill-proof.mjs'

const fixture = () => ({ identity: { databaseName: 'restore', serverUuid: 'uuid', version: '8.4.8' },
  buildProofHash: hash('build'), conversionPlanHash: hash('conversion'), sourcePlanHash: hash('source'), accountMappingHash: hash('accounts'),
  writerHash: hash('writer'), protectedSnapshotHash: hash('snapshot'), historyHash: hash('history'), tools: [{ path: 'script.mjs', sha256: hash('tool') }] })
it('binds a detached durable proof to all source, identity, registry and tool evidence', () => {
  const evidence = fixture(), proof = prepareLegacyCandleBackfillProof(evidence)
  expect(() => verifyLegacyCandleBackfillProof(proof, evidence)).not.toThrow()
  evidence.tools[0].sha256 = hash('changed')
  expect(proof.tools[0].sha256).toBe(hash('tool'))
  expect(() => verifyLegacyCandleBackfillProof(proof, evidence)).toThrow('binding')
})
for (const field of ['identity', 'buildProofHash', 'conversionPlanHash', 'sourcePlanHash', 'accountMappingHash', 'writerHash', 'protectedSnapshotHash', 'historyHash']) {
  it(`rejects rehashed ${field} changes`, () => {
    const evidence = fixture(), modified = { ...evidence, [field]: hash('other') }
    expect(() => verifyLegacyCandleBackfillProof(prepareLegacyCandleBackfillProof(modified), evidence)).toThrow('binding')
  })
}
it('includes the actual writer and backfill entrypoint in a unique frozen tool set', async () => {
  const tools = await freezeLegacyCandleBackfillTools(new URL('../', import.meta.url))
  expect(new Set(tools.map(row => row.path)).size).toBe(tools.length)
  expect(tools.some(row => row.path === 'server/routes/ai/platform-market-data.js')).toBe(true)
  expect(tools.some(row => row.path === 'scripts/rehearse-legacy-candle-backfill-local.mjs')).toBe(true)
})
