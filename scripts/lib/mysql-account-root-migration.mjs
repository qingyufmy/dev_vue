import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { sha256 } from './v4-migration-plan.mjs'
import { mysqlColumnStore, verifyInplaceJournal } from './mysql-inplace-column-store.mjs'
import { coordinateInplaceSchema } from './inplace-schema-coordinator.mjs'
import { promotedAccountHistoricalStore } from './account-root-historical-schema.mjs'
import { accountRootMigrationSnapshot } from './inplace-account-root-migration.mjs'
import { readAccountRootSnapshot } from './mysql-account-root-snapshot.mjs'

const check = (condition, code) => { if (!condition) throw Error(`account_root_store_${code}`) }
const additionalTools = ['scripts/lib/mysql-account-root-migration.mjs', 'scripts/lib/inplace-account-root-migration.mjs',
  'scripts/lib/account-root-historical-schema.mjs', 'scripts/lib/account-root-promotion.mjs', 'scripts/lib/mysql-account-root-snapshot.mjs',
  'scripts/rehearse-account-root-migration-local.mjs', 'server/db/migrations/inplace/035_account_root_promotion.sql',
  'docs/architecture/account-wave-local-rehearsal-20260908-v3.json', 'docs/architecture/account-wave-projection-verification-20260908.json']

async function requiredToolPaths(root) {
  const baseline = JSON.parse(await readFile(new URL('docs/architecture/account-wave-local-rehearsal-20260908-v3.json', root)))
  return [...new Set([...baseline.frozen.tools.map(tool => tool.path), ...additionalTools])].sort()
}
const safePath = path => typeof path === 'string' && /^[a-zA-Z0-9_.\/-]+$/.test(path)
  && !path.startsWith('/') && path.split('/').every(part => part !== '..' && part !== '.' && part.length > 0)
export async function freezeAccountRootMigrationTools(root) {
  return Promise.all((await requiredToolPaths(root)).map(async path => {
    check(safePath(path), 'tool_path')
    return { path, sha256: sha256(await readFile(new URL(path, root))) }
  }))
}
export async function verifyAccountRootMigrationTools(root, tools) {
  check(Array.isArray(tools) && tools.every(tool => safePath(tool.path)), 'tool_path')
  const paths = tools.map(tool => tool.path).sort(), expected = await requiredToolPaths(root)
  check(JSON.stringify(paths) === JSON.stringify(expected), 'tool_manifest')
  for (const tool of tools) check(sha256(await readFile(new URL(tool.path, root))) === tool.sha256, 'tool_drift')
}

export async function persistAccountRootMigrationProof(path, proof) {
  check(typeof path === 'string' && isAbsolute(path), 'proof_path')
  const file = await open(path, 'wx', 0o600)
  try { await file.writeFile(JSON.stringify(proof, null, 2) + '\n'); await file.sync() }
  finally { await file.close() }
}

// This adapter never acquires a replacement lock: a dedicated caller must hold
// the existing same-connection lock before construction and throughout work.
export async function mysqlAccountRootMigrationStore(connection, plan, root, proofPath) {
  check(typeof proofPath === 'string' && isAbsolute(proofPath), 'proof_path')
  const proof = JSON.parse(await readFile(proofPath, 'utf8'))
  const database = proof.identity?.database
  check(database === 'dev_vue' || /^dev_vue_m1_source_\d{8}_\d{2}$/.test(database), 'database')
  async function identity() {
    const [[row]] = await connection.execute('SELECT DATABASE() db,@@server_uuid uuid,CONNECTION_ID() connectionId,IS_USED_LOCK(?) lockOwner,@@autocommit autoCommit,@@session.time_zone timeZone', [`aurum:inplace:${database}`])
    check(row.db === database && row.uuid === proof.identity.serverUuid, 'identity')
    check(row.lockOwner !== null && String(row.lockOwner) === String(row.connectionId), 'lock_lost')
    check(Number(row.autoCommit) === 1 && row.timeZone === '+00:00', 'session')
    return { database: row.db, serverUuid: row.uuid }
  }
  await identity()
  check(await verifyInplaceJournal(connection), 'journal')
  const journal = mysqlColumnStore(connection, true)
  const assertStep = step => check(step?.id === plan.step.id && step.checksum === plan.step.checksum && step.sql === plan.step.sql, 'step')
  return {
    identity,
    proof: async () => structuredClone(proof),
    verifyTools: tools => verifyAccountRootMigrationTools(root, tools),
    async history() { await identity(); return journal.history() },
    async snapshot() { await identity(); return accountRootMigrationSnapshot((await readAccountRootSnapshot(connection)).tables) },
    async verifyPrior(state, history) {
      await identity()
      check(state === 'original' || state === 'promoted', 'prior_state')
      const store = state === 'promoted' ? await promotedAccountHistoricalStore(connection, plan.prior, history)
        : { ...plan.prior.store(connection), history: async () => history }
      const result = await coordinateInplaceSchema(store, plan.prior)
      check(result.structureComplete && result.steps.length === 147 && result.steps.every(step => step.status === 'completed'), 'prior_incomplete')
    },
    async begin(step) { assertStep(step); await identity(); await journal.begin(step) },
    async execute(sql) { check(sql === plan.step.sql, 'sql'); await identity(); await connection.query(sql) },
    async complete(step) { assertStep(step); await identity(); await journal.complete(step) },
  }
}
