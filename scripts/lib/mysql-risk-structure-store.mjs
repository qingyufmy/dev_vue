import { readFile } from 'node:fs/promises'
import { hash } from './v4-backfill-contract.mjs'
import { sha256 } from './v4-migration-plan.mjs'
import { mysqlColumnStore, verifyInplaceJournal } from './mysql-inplace-column-store.mjs'
import { readAccountRootSnapshot } from './mysql-account-root-snapshot.mjs'
import { legacyCandlePromotionSnapshot } from './legacy-candle-promotion.mjs'
import { mysqlContextChangesStore, freezeContextChangesTools } from './mysql-current-context-changes.mjs'
import { coordinateContextChanges } from './context-changes-coordinator.mjs'
import { riskStructureHistoricalConnection } from './risk-structure-historical-connection.mjs'
import { readRiskStructureTable } from './mysql-risk-structure-state.mjs'
import { prepareRiskStructureProof } from './risk-structure-proof.mjs'
import { loadRiskStructureMigration } from './inplace-risk-structure.mjs'
import { verifyRiskPriorHistory } from './risk-prior-history.mjs'

const check = (value, code) => { if (!value) throw Error('risk_structure_store_' + code) }
const paths = ['server/db/migrations/inplace/043_risk_core_structures.sql',
  'scripts/apply-risk-current-upgrade-local.mjs', 'scripts/run-risk-current-application-local.py',
  'server/db/migrations/inplace/042_observer_registry_seed.sql', 'scripts/lib/observer-registry-seed.mjs', 'scripts/lib/risk-prior-history.mjs',
  'scripts/verify-risk-structure-reference-local.mjs',
  'scripts/run-risk-reference-local.py',
  'scripts/backup-risk-dev-vue-local.mjs', 'scripts/run-risk-backup-local.py', 'scripts/lib/risk-backup-parity.mjs',
  'scripts/inspect-risk-restored-baseline-local.mjs', 'scripts/run-risk-restored-baseline-local.py',
  'scripts/rehearse-risk-structure-local.mjs', 'scripts/run-risk-rehearsal-local.py',
  'scripts/lib/risk-restoration-evidence.mjs', 'scripts/lib/risk-tool-transition.mjs',
  'scripts/verify-risk-restoration-evidence-local.mjs', 'scripts/prepare-risk-upgrade-proof-local.mjs',
  'scripts/lib/risk-structure-source.mjs', 'scripts/lib/inplace-risk-structure.mjs',
  'scripts/lib/risk-structure-coordinator.mjs', 'scripts/lib/mysql-risk-structure-state.mjs',
  'scripts/lib/risk-structure-historical-connection.mjs', 'scripts/lib/risk-structure-proof.mjs',
  'scripts/lib/mysql-risk-structure-store.mjs']
export async function freezeRiskStructureTools(root) {
  return [...await freezeContextChangesTools(root), ...await Promise.all(paths.map(async path =>
    ({ path, sha256: sha256(await readFile(new URL(path, root))) })))].sort((a, b) => a.path.localeCompare(b.path))
}

export async function assertRiskUpgradeConnection(connection) {
  const [[row]] = await connection.query('SELECT DATABASE() db,@@server_uuid serverUuid,@@session.time_zone timezone,CONNECTION_ID() connectionId,CURRENT_USER() principal')
  check(row.db === 'dev_vue' && row.serverUuid === 'ac423207-6ef3-11f1-b302-000c29fda104' && row.timezone === '+00:00', 'identity')
  // The existing migration workflow uses root; a restricted account cannot prove
  // that PROCESSLIST includes all application clients.
  check(typeof row.principal === 'string' && row.principal.startsWith('root@'), 'administrative_connection_required')
  const [[lock]] = await connection.execute('SELECT IS_USED_LOCK(?) owner', ['aurum:inplace:dev_vue'])
  check(lock.owner !== null && String(lock.owner) === String(row.connectionId), 'lock_lost')
  const [[clients]] = await connection.query('SELECT COUNT(*) n FROM information_schema.PROCESSLIST WHERE DB=DATABASE() AND ID<>CONNECTION_ID()')
  check(Number(clients.n) === 0, 'other_clients')
  return { database: row.db, serverUuid: row.serverUuid }
}

// Caller acquires the existing inplace lock before constructing the store.
// No migrations or implicit transactions are started during construction.
export async function mysqlRiskStructureStore(connection, plan, root, options) {
  const json = async path => JSON.parse(await readFile(path, 'utf8'))
  const proof = await json(options.proofPath)
  const identityAndLock = () => assertRiskUpgradeConnection(connection)
  await identityAndLock()
  const prior = await mysqlContextChangesStore(riskStructureHistoricalConnection(connection), plan.prior.context, root,
    options.priorProofPath, options.priorPaths)
  const journal = mysqlColumnStore(connection, true)
  async function verifyPlan(candidate) {
    const identity = await identityAndLock()
    const current = await loadRiskStructureMigration(root)
    check(hash(candidate.steps) === hash(current.steps) && hash(plan.steps) === hash(current.steps), 'registry')
    await prior.verifyPlan(plan.prior.context)
    const reference = await json(options.referencePath), restore = await json(options.restorePath)
    const expected = prepareRiskStructureProof(plan, identity, await prior.proof(), proof.priorSnapshot,
      reference, restore, await freezeRiskStructureTools(root))
    check(hash(expected) === hash(proof), 'proof_drift')
    await verifyInplaceJournal(connection)
    return structuredClone(proof.definitions)
  }
  await verifyPlan(plan)
  const assertStep = step => {
    const index = plan.additions.findIndex(row => hash(row) === hash(step))
    check(index >= 0, 'step')
    return proof.definitions[index]
  }
  return {
    verifyPlan, identity: identityAndLock, proof: async () => structuredClone(proof),
    async history() { await identityAndLock(); return journal.history() },
    async tableState(table) { await identityAndLock(); return readRiskStructureTable(connection, table) },
    async snapshot() { await identityAndLock(); return legacyCandlePromotionSnapshot((await readAccountRootSnapshot(connection)).tables) },
    async verifyProtected(snapshot, completed) {
      const schemas = rows => rows.map(({ name, schemaSha256 }) => ({ name, schemaSha256 }))
      check(hash(schemas(snapshot)) === hash(schemas(proof.priorSnapshot)), 'prior_schema_changed')
      if (!completed) check(hash(snapshot) === hash(proof.priorSnapshot), 'prior_rows_changed')
    },
    async verifyPrior(history, snapshot) {
      const checked = await verifyRiskPriorHistory(connection, plan.prior, history)
      return coordinateContextChanges({ ...prior, history: async () => checked.contextHistory, snapshot: async () => snapshot }, plan.prior.context)
    },
    async begin(step) { assertStep(step); await verifyPlan(plan); await journal.begin(step) },
    async execute(step) {
      const definition = assertStep(step)
      await verifyPlan(plan)
      const entry = (await journal.history()).find(row => row.id === step.id)
      check(entry?.status === 'started' && entry.checksum === step.checksum, 'ddl_not_started')
      const actual = await readRiskStructureTable(connection, step.table)
      check((actual?.hash ?? null) === definition.beforeHash && (!actual || actual.rows === 0), 'ddl_precondition')
      await identityAndLock()
      await connection.query(step.sql)
    },
    async complete(step) {
      const definition = assertStep(step)
      await verifyPlan(plan)
      const actual = await readRiskStructureTable(connection, step.table)
      check(actual?.hash === definition.afterHash && actual.rows === 0, 'completion_precondition')
      await identityAndLock()
      await journal.complete(step)
    },
  }
}
