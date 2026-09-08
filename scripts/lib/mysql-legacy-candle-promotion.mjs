import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { hash } from './v4-backfill-contract.mjs'
import { sha256 } from './v4-migration-plan.mjs'
import { freezeLegacyCandleBackfillTools } from './legacy-candle-backfill-proof.mjs'
import { mysqlColumnStore } from './mysql-inplace-column-store.mjs'
import { readAccountRootSnapshot } from './mysql-account-root-snapshot.mjs'
import { mysqlLegacyCandleBuildMigrationStore } from './mysql-legacy-candle-build-migration.mjs'
import { coordinateLegacyCandleBuildMigration } from './legacy-candle-build-coordinator.mjs'
import { promotedLegacyCandlePriorStore } from './legacy-candle-historical-store.mjs'
import { legacyCandlePromotionSnapshot } from './legacy-candle-promotion.mjs'
import { prepareLegacyCandlePromotionProof, validateLegacyCandlePromotionProof } from './inplace-legacy-candle-promotion.mjs'

const check = (value, code) => { if (!value) throw Error('legacy_candle_promotion_store_' + code) }
const additions = ['scripts/lib/mysql-legacy-candle-promotion.mjs', 'scripts/lib/inplace-legacy-candle-promotion.mjs',
  'scripts/lib/legacy-candle-promotion.mjs', 'scripts/lib/legacy-candle-historical-schema.mjs', 'scripts/lib/legacy-candle-historical-store.mjs',
  'scripts/rehearse-legacy-candle-promotion-local.mjs', 'server/db/migrations/inplace/040_legacy_candle_promotion.sql',
  'docs/architecture/legacy-candle-backfill-plan-20260908.json', 'docs/architecture/legacy-candle-backfill-repeat-20260908.json']
export async function freezeLegacyCandlePromotionTools(root) {
  return [...await freezeLegacyCandleBackfillTools(root), ...await Promise.all(additions.map(async path => ({
    path, sha256: sha256(await readFile(new URL(path, root))),
  })))].sort((a, b) => a.path.localeCompare(b.path))
}
export function verifyCandleBackfillEvidence(backfill, receipt, identity) {
  const { proofHash, ...body } = backfill
  check(body.kind === 'legacy-candle-backfill-proof/v1' && hash(body) === proofHash, 'backfill_hash')
  check(body.identity.databaseName === identity.database && body.identity.serverUuid === identity.serverUuid, 'backfill_identity')
  check(receipt.kind === 'legacy-candle-backfill-rehearsal/v1' && receipt.proofHash === proofHash && hash(receipt.identity) === hash(body.identity)
    && receipt.result.status === 'verified' && receipt.result.batches === 0 && receipt.committedBatches === 0
    && receipt.conversionPlanHash === body.conversionPlanHash && receipt.result.planHash === body.conversionPlanHash
    && receipt.result.mappedRows === receipt.inputRows && receipt.result.projectionRows === receipt.outputRows
    && receipt.protectedSnapshotHash === body.protectedSnapshotHash && receipt.historyHash === body.historyHash, 'backfill_receipt')
}
export function prepareVerifiedCandlePromotionProof(plan, identity, tables, backfill, receipt, historyHash, tools) {
  verifyCandleBackfillEvidence(backfill, receipt, identity)
  check(historyHash === receipt.historyHash, 'history_changed')
  const before = legacyCandlePromotionSnapshot(tables), names = new Set(plan.prior.additions.map(row => row.table))
  check(hash(before.filter(row => !names.has(row.name))) === receipt.protectedSnapshotHash, 'source_changed')
  const area = before.filter(row => names.has(row.name)).map(({ name, rows, rowsSha256, schemaSha256 }) => ({ name, rows, rowsSha256, schemaSha256 }))
  check(hash(area) === hash(receipt.buildTables) && area.length === 3, 'backfill_data_changed')
  const proof = prepareLegacyCandlePromotionProof(plan, identity, tables, backfill.proofHash, tools)
  validateLegacyCandlePromotionProof(proof, plan, identity)
  return proof
}

export async function mysqlLegacyCandlePromotionStore(connection, plan, root, paths) {
  check(['proof', 'build', 'projection', 'observer', 'terminal', 'account'].every(key => isAbsolute(paths[key])), 'paths')
  const priorStore = await mysqlLegacyCandleBuildMigrationStore(connection, plan.prior, root,
    paths.build, paths.projection, paths.observer, paths.terminal, paths.account)
  const rootStore = priorStore.priorStore.priorStore.priorStore.rootStore
  const proof = JSON.parse(await readFile(paths.proof, 'utf8')), buildProof = JSON.parse(await readFile(paths.build, 'utf8'))
  const backfill = JSON.parse(await readFile(new URL('docs/architecture/legacy-candle-backfill-plan-20260908.json', root), 'utf8'))
  const receipt = JSON.parse(await readFile(new URL('docs/architecture/legacy-candle-backfill-repeat-20260908.json', root), 'utf8'))
  const journal = mysqlColumnStore(connection, true)
  async function authorize() {
    validateLegacyCandlePromotionProof(proof, plan, await rootStore.identity())
    verifyCandleBackfillEvidence(backfill, receipt, await rootStore.identity())
    check(proof.backfillProofHash === backfill.proofHash, 'backfill_binding')
    check(hash(proof.tools) === hash(await freezeLegacyCandlePromotionTools(root)), 'tools')
  }
  await authorize()
  return {
    priorStore, identity: () => rootStore.identity(), history: () => rootStore.history(), proof: async () => structuredClone(proof),
    async rawSnapshot() { await rootStore.identity(); return (await readAccountRootSnapshot(connection)).tables },
    async snapshot() { await rootStore.identity(); return legacyCandlePromotionSnapshot((await readAccountRootSnapshot(connection)).tables) },
    async verifyTools(tools) { await authorize(); check(hash(tools) === hash(proof.tools), 'tools') },
    async verifyBackfillProof(expected) { await authorize(); check(expected === backfill.proofHash, 'backfill_binding') },
    async verifyPrior(state, history) {
      check(['original', 'promoted'].includes(state), 'state')
      const oldStore = state === 'original' ? { ...priorStore, history: async () => history }
        : await promotedLegacyCandlePriorStore(connection, priorStore, plan.prior, history,
          (await readAccountRootSnapshot(connection)).tables, buildProof.definitions)
      const result = await coordinateLegacyCandleBuildMigration(oldStore, plan.prior)
      check(result.steps.every(row => row.status === 'completed'), 'prior_incomplete')
    },
    async begin(step) { check(hash(step) === hash(plan.step), 'step'); await authorize(); await journal.begin(step) },
    async execute(sql) { check(sql === plan.step.sql, 'sql'); await authorize(); await connection.query(sql) },
    async complete(step) { check(hash(step) === hash(plan.step), 'step'); await authorize(); await journal.complete(step) },
  }
}
