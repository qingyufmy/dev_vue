// Current database adapter; the executed restored adapter remains frozen.
import { readFile } from 'node:fs/promises'
import { hash } from './v4-backfill-contract.mjs'
import { sha256 } from './v4-migration-plan.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'
import { mysqlColumnStore } from './mysql-inplace-column-store.mjs'
import { readAccountRootSnapshot } from './mysql-account-root-snapshot.mjs'
import { legacyCandlePromotionSnapshot } from './legacy-candle-promotion.mjs'
import { coordinateLegacyCandlePromotion } from './inplace-legacy-candle-promotion.mjs'
import { freezeLegacyCandlePromotionTools, mysqlLegacyCandlePromotionStore } from './mysql-current-legacy-candle-promotion.mjs'
import { contextChangesHistoricalConnection } from './context-changes-historical-connection.mjs'

const check = (value, code) => { if (!value) throw Error('context_changes_store_' + code) }
const source = 'server/db/migrations/inplace/041_trading_context_changes.sql'
const referencePath = 'docs/architecture/current-context-receipt-schema-reference-20260908.json'
const paths = ['scripts/lib/mysql-context-changes.mjs', 'scripts/lib/context-changes-coordinator.mjs',
  'scripts/lib/context-changes-historical-connection.mjs', 'scripts/lib/inplace-trading-context-changes.mjs',
  'scripts/rehearse-context-changes-local.mjs', 'scripts/verify-context-receipt-schema-local.mjs', source, referencePath,
  'scripts/lib/mysql-current-context-changes.mjs', 'scripts/upgrade-current-context-changes-local.mjs']
export async function freezeContextChangesTools(root) {
  return [...await freezeLegacyCandlePromotionTools(root), ...await Promise.all(paths.map(async path => ({
    path, sha256: sha256(await readFile(new URL(path, root))),
  })))].sort((a, b) => a.path.localeCompare(b.path))
}

export function prepareContextChangesProof(plan, identity, priorProof, priorSnapshot, reference, tools, priorHistory) {
  check(identity.database === 'dev_vue' && hash(identity) === hash(priorProof.identity), 'prior_identity')
  check(reference.kind === 'context-receipt-schema-reference/v1' && reference.identity.serverUuid === identity.serverUuid
    && reference.registrySteps === 165 && reference.stepChecksum === plan.additions[0].checksum
    && reference.referenceDatabaseRemoved === true && reference.existingDatabaseWrites === 0, 'reference')
  check(reference.checks.length === 13 && reference.checks.every(row => row.passed === true)
    && new Set(reference.checks.map(row => row.name)).size === 13, 'reference_checks')
  check(reference.sourceHash === tools.find(row => row.path === source)?.sha256
    && reference.toolHash === tools.find(row => row.path === 'scripts/verify-context-receipt-schema-local.mjs')?.sha256, 'reference_tools')
  check(reference.canonicalDdl.startsWith('CREATE TABLE `trading_context_changes_v4` ('), 'definition')
  check(hash(priorSnapshot.map(row => row.name)) === hash(priorProof.after.map(row => row.name)), 'prior_tables')
  const body = { kind: 'context-changes-proof/v1', identity, priorProofHash: priorProof.proofHash,
    priorHistoryHash: hash(priorHistory),
    registryHash: hash(plan.steps.map(({ id, checksum }) => ({ id, checksum }))), priorSnapshot,
    definition: { ddl: reference.canonicalDdl, schemaHash: tableDefinitionHash(reference.canonicalDdl) },
    referenceHash: hash(reference), tools }
  return { ...body, proofHash: hash(body) }
}

export async function mysqlContextChangesStore(connection, plan, root, proofPath, priorPaths) {
  const proof = JSON.parse(await readFile(proofPath, 'utf8'))
  const prior = await mysqlLegacyCandlePromotionStore(contextChangesHistoricalConnection(connection), plan.prior, root, priorPaths)
  const priorProof = await prior.proof(), reference = JSON.parse(await readFile(new URL(referencePath, root), 'utf8'))
  const journal = mysqlColumnStore(connection, true)
  async function verifyPlan(candidate) {
    check(hash(candidate.steps) === hash(plan.steps), 'registry')
    const tools = await freezeContextChangesTools(root)
    const expected = prepareContextChangesProof(plan, await prior.identity(), priorProof, proof.priorSnapshot, reference, tools, (await prior.history()).filter(row => plan.prior.steps.some(step => step.id === row.id)))
    check(hash(expected) === hash(proof), 'proof_drift')
  }
  await verifyPlan(plan)
  const assertStep = step => check(hash(step) === hash(plan.additions[0]), 'step')
  return {
    prior, verifyPlan, identity: () => prior.identity(), history: () => prior.history(), proof: async () => structuredClone(proof),
    async snapshot() { await prior.identity(); return legacyCandlePromotionSnapshot((await readAccountRootSnapshot(connection)).tables) },
    async tableState(step) {
      assertStep(step); await prior.identity()
      const [tables] = await connection.execute('SELECT TABLE_TYPE kind FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [step.table])
      if (!tables.length) return null
      check(tables.length === 1 && tables[0].kind === 'BASE TABLE', 'table_kind')
      const [[ddl]] = await connection.query('SHOW CREATE TABLE `trading_context_changes_v4`')
      const [[count]] = await connection.query('SELECT COUNT(*) n FROM `trading_context_changes_v4`')
      const [triggers] = await connection.execute('SELECT TRIGGER_NAME name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=?', [step.table])
      return { matches: triggers.length === 0 && tableDefinitionHash(ddl['Create Table']) === proof.definition.schemaHash, rows: Number(count.n) }
    },
    async verifyProtected(snapshot, completed) {
      const schemas = rows => rows.map(({ name, schemaSha256 }) => ({ name, schemaSha256 }))
      check(hash(schemas(snapshot)) === hash(schemas(proof.priorSnapshot)), 'prior_schema_changed')
      if (!completed) check(hash(snapshot) === hash(proof.priorSnapshot), 'prior_rows_changed')
    },
    async verifyPrior(history, snapshot) {
      return coordinateLegacyCandlePromotion({ ...prior, history: async () => history, snapshot: async () => snapshot }, plan.prior)
    },
    async begin(step) { assertStep(step); await verifyPlan(plan); await journal.begin(step) },
    async execute(step) { assertStep(step); await verifyPlan(plan); await connection.query(step.sql) },
    async complete(step) { assertStep(step); await verifyPlan(plan); await journal.complete(step) },
  }
}
