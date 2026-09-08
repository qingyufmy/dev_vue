import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { hash } from './v4-backfill-contract.mjs'
import { sha256 } from './v4-migration-plan.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'
import { mysqlColumnStore } from './mysql-inplace-column-store.mjs'
import { mysqlAccountRootMigrationStore, freezeAccountRootMigrationTools, persistAccountRootMigrationProof } from './mysql-account-root-migration.mjs'

const check = (condition, code) => { if (!condition) throw Error(`terminal_route_store_${code}`) }
const additions = ['scripts/lib/mysql-terminal-route-migration.mjs', 'scripts/lib/terminal-route-coordinator.mjs',
  'scripts/lib/inplace-terminal-route-migration.mjs', 'server/db/migrations/inplace/036_terminal_route_tables.sql',
  'scripts/capture-terminal-route-reference-local.mjs', 'scripts/rehearse-terminal-route-migration-local.mjs',
  'docs/architecture/terminal-route-reference-20260908.json']
export async function freezeTerminalRouteTools(root) {
  return [...await freezeAccountRootMigrationTools(root), ...await Promise.all(additions.map(async path => ({
    path, sha256: sha256(await readFile(new URL(path, root))),
  })))].sort((a, b) => a.path.localeCompare(b.path))
}

// canonicalDefinitions must come from separately verified MySQL reference DDL,
// bound to each exact CREATE statement. This function does not synthesize SHOW CREATE.
export function prepareTerminalRouteProof(plan, identity, rootProof, priorSnapshot, canonicalDefinitions, tools) {
  check(Array.isArray(canonicalDefinitions) && canonicalDefinitions.length === plan.additions.length, 'definitions')
  const definitions = plan.additions.map(step => {
    const definition = canonicalDefinitions.find(item => item.table === step.table)
    check(definition?.sourceSqlHash === hash(step.sql) && typeof definition.ddl === 'string' && definition.ddl.startsWith('CREATE TABLE `' + step.table + '` ('), 'definition_binding')
    return { ...definition, schemaHash: tableDefinitionHash(definition.ddl) }
  })
  check(hash(identity) === hash(rootProof.identity), 'root_identity')
  const value = { kind: 'terminal-route-proof/v1', identity, rootProofHash: rootProof.proofHash,
    registryHash: hash(plan.steps.map(({ id, checksum }) => ({ id, checksum }))),
    priorSnapshot, definitions, tools }
  const proof = { ...value, proofHash: hash(value) }
  validateTerminalRouteProof(proof, plan, identity, rootProof)
  return structuredClone(proof)
}

export async function persistTerminalRouteProof(path, proof) {
  await persistAccountRootMigrationProof(path, proof)
}

export function validateTerminalRouteProof(proof, plan, identity, rootProof) {
  const { proofHash, ...value } = proof ?? {}
  check(value.kind === 'terminal-route-proof/v1' && hash(value) === proofHash, 'proof_hash')
  check(hash(value.identity) === hash(identity) && value.rootProofHash === rootProof.proofHash, 'proof_identity')
  check(value.registryHash === hash(plan.steps.map(({ id, checksum }) => ({ id, checksum }))), 'registry')
  check(Array.isArray(value.priorSnapshot) && hash(value.priorSnapshot.map(item => item.name).sort()) === hash(rootProof.after.map(item => item.name).sort()), 'prior_tables')
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
export async function mysqlTerminalRouteMigrationStore(connection, plan, root, proofPath, rootProofPath) {
  check(isAbsolute(proofPath) && isAbsolute(rootProofPath), 'proof_path')
  const proof = JSON.parse(await readFile(proofPath, 'utf8'))
  const rootStore = await mysqlAccountRootMigrationStore(connection, plan.prior, root, rootProofPath)
  const rootProof = await rootStore.proof()
  const journal = mysqlColumnStore(connection, true)
  const assertStep = step => check(plan.additions.some(expected => hash(expected) === hash(step)), 'step')
  async function verifyPlan(candidate) {
    check(hash(candidate.steps) === hash(plan.steps), 'plan')
    validateTerminalRouteProof(proof, plan, await rootStore.identity(), rootProof)
    check(hash(proof.tools) === hash(await freezeTerminalRouteTools(root)), 'tools')
  }
  await verifyPlan(plan)
  return {
    rootStore, verifyPlan,
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
