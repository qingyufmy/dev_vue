import { hash } from './v4-backfill-contract.mjs'
import { validateColumnHistory } from './dev-vue-column-upgrade.mjs'
import { legacyCandlePromotionSnapshot } from './legacy-candle-promotion.mjs'
import { promotedCandleMetadataConnection } from './legacy-candle-historical-schema.mjs'
import { promotedAccountHistoricalStore } from './account-root-historical-schema.mjs'
import { coordinateInplaceSchema } from './inplace-schema-coordinator.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'

const check = (value, code) => { if (!value) throw Error('legacy_candle_prior_' + code) }
const blocked = () => { throw Error('legacy_candle_prior_write_forbidden') }
const readonly = store => ({ ...store, begin: blocked, execute: blocked, complete: blocked })

// The outer 164-step coordinator validates its complete registry first, then
// supplies exactly the 163 historical rows and a fresh physical table snapshot.
// No original migration, checksum or saved proof is modified by this projection.
export async function promotedLegacyCandlePriorStore(connection, store, plan, history, tables, definitions) {
  const validated = validateColumnHistory(history, plan.steps)
  check(plan.steps.every(step => validated.get(step.id)?.status === 'completed'), 'incomplete')
  await store.verifyPlan(plan)
  const snapshot = legacyCandlePromotionSnapshot(tables, { historical: true })
  check(Array.isArray(definitions) && definitions.length === plan.additions.length, 'definitions')
  for (const step of plan.additions) {
    const definition = definitions.find(row => row.table === step.table)
    check(definition && definition.sourceSqlHash === hash(step.sql)
      && definition.schemaHash === tableDefinitionHash(definition.ddl), 'definition_binding')
  }
  const projectionStore = store.priorStore, observerStore = projectionStore.priorStore, terminalStore = observerStore.priorStore
  const rootStore = terminalStore.rootStore, originalPlan = plan.prior.prior.prior.prior.prior
  const historicalRoot = {
    ...readonly(rootStore), snapshot: async () => structuredClone(snapshot),
    async verifyPrior(state, rows) {
      check(state === 'promoted', 'account_state')
      const original = await promotedAccountHistoricalStore(promotedCandleMetadataConnection(connection), originalPlan, rows)
      const result = await coordinateInplaceSchema(original, originalPlan)
      check(result.structureComplete && result.steps.length === originalPlan.steps.length
        && result.steps.every(row => row.status === 'completed'), 'original_structure')
    },
  }
  return {
    ...readonly(store), history: async () => structuredClone(history),
    async tableState(step) {
      check(plan.additions.some(expected => hash(expected) === hash(step)), 'step')
      const actual = snapshot.find(row => row.name === step.table)
      if (!actual) return null
      return { matches: actual.schemaSha256 === definitions.find(row => row.table === step.table).schemaHash, rows: actual.rows }
    },
    priorStore: { ...readonly(projectionStore),
      priorStore: { ...readonly(observerStore),
        priorStore: { ...readonly(terminalStore), rootStore: historicalRoot } } },
  }
}
