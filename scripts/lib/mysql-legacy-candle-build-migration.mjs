import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { hash } from './v4-backfill-contract.mjs'
import { sha256 } from './v4-migration-plan.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'
import { mysqlColumnStore } from './mysql-inplace-column-store.mjs'
import { persistAccountRootMigrationProof } from './mysql-account-root-migration.mjs'
import { mysqlAccountProjectionMigrationStore, freezeAccountProjectionTools } from './mysql-account-projection-migration.mjs'

const check = (condition, code) => { if (!condition) throw Error(`legacy_candle_build_store_${code}`) }
const additions = ['scripts/lib/mysql-legacy-candle-build-migration.mjs', 'scripts/lib/legacy-candle-build-coordinator.mjs',
  'scripts/lib/inplace-legacy-candle-build-migration.mjs', 'server/db/migrations/inplace/039_legacy_candle_build_tables.sql',
  'scripts/capture-legacy-candle-reference-local.mjs', 'scripts/lib/legacy-candle-reference-checks.mjs',
  'scripts/rehearse-legacy-candle-build-migration-local.mjs', 'docs/architecture/legacy-candle-build-reference-20260908.json']
export async function freezeLegacyCandleBuildTools(root) {
  return [...await freezeAccountProjectionTools(root), ...await Promise.all(additions.map(async path => ({
    path, sha256: sha256(await readFile(new URL(path, root))),
  })))].sort((a, b) => a.path.localeCompare(b.path))
}

// canonicalDefinitions must come from separately verified MySQL reference DDL,
// bound to each exact CREATE statement. This function does not synthesize SHOW CREATE.
export function prepareLegacyCandleBuildProof(plan, identity, priorProof, priorSnapshot, reference, tools) {
  const canonicalDefinitions = reference.definitions
  const { proofHash: referenceHash, ...referenceBody } = reference
  check(reference.kind === 'legacy-candle-build-reference/v1' && hash(referenceBody) === referenceHash, 'reference_hash')
  check(reference.referenceRemoved === true && reference.sourceWritten === false
    && hash(reference.identity) === hash(identity) && reference.priorProofHash === priorProof.proofHash
    && reference.registryHash === hash(plan.steps.map(({ id, checksum }) => ({ id, checksum })))
    && reference.sourceSnapshotHash === hash(priorSnapshot), 'reference_binding')
  check(Array.isArray(canonicalDefinitions) && canonicalDefinitions.length === plan.additions.length, 'definitions')
  const definitions = plan.additions.map(step => {
    const definition = canonicalDefinitions.find(item => item.table === step.table)
    check(definition?.sourceSqlHash === hash(step.sql) && typeof definition.ddl === 'string' && definition.ddl.startsWith('CREATE TABLE `' + step.table + '` ('), 'definition_binding')
    return { ...definition, schemaHash: tableDefinitionHash(definition.ddl) }
  })
  check(hash(identity) === hash(priorProof.identity), 'root_identity')
  const value = { kind: 'legacy-candle-build-proof/v1', identity, priorProofHash: priorProof.proofHash,
    registryHash: hash(plan.steps.map(({ id, checksum }) => ({ id, checksum }))),
    priorSnapshot, definitions, tools, referenceHash }
  const proof = { ...value, proofHash: hash(value) }
  validateLegacyCandleBuildProof(proof, plan, identity, priorProof)
  return structuredClone(proof)
}

export async function persistLegacyCandleBuildProof(path, proof) {
  await persistAccountRootMigrationProof(path, proof)
}

export function validateLegacyCandleBuildProof(proof, plan, identity, priorProof) {
  const { proofHash, ...value } = proof ?? {}
  check(value.kind === 'legacy-candle-build-proof/v1' && hash(value) === proofHash, 'proof_hash')
  check(hash(value.identity) === hash(identity) && value.priorProofHash === priorProof.proofHash, 'proof_identity')
  check(value.registryHash === hash(plan.steps.map(({ id, checksum }) => ({ id, checksum }))), 'registry')
  check(Array.isArray(value.priorSnapshot) && hash(value.priorSnapshot.map(item => item.name).sort()) === hash([...priorProof.priorSnapshot.map(item => item.name), ...priorProof.definitions.map(item => item.table)].sort()), 'prior_tables')
  const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
  check(value.priorSnapshot.every(row => digest(row.ddlSha256) && digest(row.schemaSha256)
    && (row.name === 'database_upgrade_steps_v4' ? row.rows === undefined && row.rowsSha256 === undefined
      : Number.isSafeInteger(row.rows) && row.rows >= 0 && digest(row.rowsSha256))), 'prior_snapshot')
  check(Array.isArray(value.tools) && value.tools.length > 0
    && new Set(value.tools.map(tool => tool.path)).size === value.tools.length
    && value.tools.every(tool => typeof tool.path === 'string' && digest(tool.sha256)), 'tools')
  check(Array.isArray(value.definitions) && value.definitions.length === plan.additions.length, 'definitions')
  for (const step of plan.additions) {
    const definition = value.definitions.find(item => item.table === step.table)
    check(definition && definition.sourceSqlHash === hash(step.sql)
      && typeof definition.ddl === 'string' && definition.ddl.startsWith('CREATE TABLE `' + step.table + '` (')
      && definition.schemaHash === tableDefinitionHash(definition.ddl), 'definition_binding')
  }
}

// Caller holds aurum:inplace:<database> on this exact connection, UTC/autocommit=1.
export async function mysqlLegacyCandleBuildMigrationStore(connection, plan, root, proofPath, priorProofPath, observerProofPath, terminalProofPath, rootProofPath) {
  check(isAbsolute(observerProofPath) && isAbsolute(proofPath) && isAbsolute(priorProofPath) && isAbsolute(rootProofPath) && isAbsolute(terminalProofPath), 'proof_path')
  const proof = JSON.parse(await readFile(proofPath, 'utf8'))
  const priorStore = await mysqlAccountProjectionMigrationStore(connection, plan.prior, root, priorProofPath, observerProofPath, terminalProofPath, rootProofPath)
  const rootStore = priorStore.priorStore.priorStore.rootStore
  const priorProof = JSON.parse(await readFile(priorProofPath, 'utf8'))
  const reference = JSON.parse(await readFile(new URL('docs/architecture/legacy-candle-build-reference-20260908.json', root), 'utf8'))
  const journal = mysqlColumnStore(connection, true)
  const assertStep = step => check(plan.additions.some(expected => hash(expected) === hash(step)), 'step')
  async function verifyPlan(candidate) {
    check(hash(candidate.steps) === hash(plan.steps), 'plan')
    validateLegacyCandleBuildProof(proof, plan, await rootStore.identity(), priorProof)
    check(proof.referenceHash === reference.proofHash && hash(proof.definitions) === hash(reference.definitions), 'reference_binding')
    check(hash(proof.tools) === hash(await freezeLegacyCandleBuildTools(root)), 'tools')
  }
  await verifyPlan(plan)
  return {
    priorStore, verifyPlan,
    history: () => rootStore.history(),
    async tableState(step) {
      assertStep(step); await rootStore.identity()
      const [tables] = await connection.execute('SELECT TABLE_TYPE tableType FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', [step.table])
      if (!tables.length) return null
      if (tables.length !== 1 || tables[0].tableType !== 'BASE TABLE') return { matches: false, rows: 0 }
      const [[row]] = await connection.query('SHOW CREATE TABLE `' + step.table + '`')
      const [[count]] = await connection.query('SELECT COUNT(*) rowCount FROM `' + step.table + '`')
      return { matches: tableDefinitionHash(row['Create Table']) === proof.definitions.find(item => item.table === step.table).schemaHash,
        rows: Number(count.rowCount) }
    },
    async verifyProtected(snapshot, completed) {
      await rootStore.identity()
      if (!completed) check(hash(snapshot) === hash(proof.priorSnapshot), 'protected_rows_changed')
      else check(hash(snapshot.map(({ name, schemaSha256 }) => ({ name, schemaSha256 })))
        === hash(proof.priorSnapshot.map(({ name, schemaSha256 }) => ({ name, schemaSha256 }))), 'protected_schema_changed')
    },
    async begin(step) { assertStep(step); await verifyPlan(plan); await journal.begin(step) },
    async execute(step) { assertStep(step); await verifyPlan(plan); await connection.query(step.sql) },
    async complete(step) { assertStep(step); await verifyPlan(plan); await journal.complete(step) },
  }
}
