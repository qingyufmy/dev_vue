// Current database evidence chain; keep the executed restored proof tool intact.
import { readFile } from 'node:fs/promises'
import { hash } from './v4-backfill-contract.mjs'
import { sha256 } from './v4-migration-plan.mjs'
import { freezeLegacyCandleBuildTools } from './mysql-current-legacy-candle-build-migration.mjs'

const additions = ['scripts/lib/legacy-candle-backfill-proof.mjs', 'scripts/lib/legacy-candle-backfill.mjs',
  'scripts/lib/legacy-candle-conversion.mjs', 'scripts/lib/mysql-legacy-candle-source.mjs',
  'scripts/lib/mysql-legacy-candle-backfill.mjs', 'scripts/rehearse-legacy-candle-backfill-local.mjs',
  'docs/architecture/current-legacy-candle-conversion-20260908.json', 'scripts/lib/current-legacy-candle-backfill-proof.mjs', 'scripts/backfill-current-legacy-candles-local.mjs', 'server/routes/ai/platform-market-data.js']
const check = (value, code) => { if (!value) throw Error('legacy_candle_proof_' + code) }
export async function freezeLegacyCandleBackfillTools(root) {
  return [...await freezeLegacyCandleBuildTools(root), ...await Promise.all(additions.map(async path => ({
    path, sha256: sha256(await readFile(new URL(path, root))),
  })))].sort((a, b) => a.path.localeCompare(b.path))
}
export function prepareLegacyCandleBackfillProof(evidence) {
  const proof = { kind: 'legacy-candle-backfill-proof/v1', ...structuredClone(evidence) }
  return { ...proof, proofHash: hash(proof) }
}
export function verifyLegacyCandleBackfillProof(proof, evidence) {
  const { proofHash, ...body } = proof ?? {}
  check(hash(body) === proofHash, 'hash')
  check(hash(proof) === hash(prepareLegacyCandleBackfillProof(evidence)), 'binding')
}
