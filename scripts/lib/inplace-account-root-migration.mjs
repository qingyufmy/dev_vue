import { readFile } from 'node:fs/promises'
import { accountRootRenames, accountRootRenameSql } from './account-root-promotion.mjs'
import { loadSubscriptionForeignKeyCoordinator } from './inplace-subscription-foreign-key-schema.mjs'
import { splitSqlStatements, sha256 } from './v4-migration-plan.mjs'
import { tableDefinitionHash } from './inplace-foundation-upgrade.mjs'
import { validateColumnHistory } from './dev-vue-column-upgrade.mjs'
import { hash } from './v4-backfill-contract.mjs'

const journalName = 'database_upgrade_steps_v4'
const check = (condition, code) => { if (!condition) throw Error(`account_root_migration_${code}`) }
export async function loadAccountRootMigration(root) {
  const prior = await loadSubscriptionForeignKeyCoordinator(root)
  check(prior.steps.length === 147, 'prior_version')
  const statements = splitSqlStatements(await readFile(new URL('server/db/migrations/inplace/035_account_root_promotion.sql', root), 'utf8'))
  check(statements.length === 1 && statements[0] === accountRootRenameSql(), 'sql_drift')
  const priorRegistryHash = hash(prior.steps.map(({ id, checksum }) => ({ id, checksum })))
  const body = { id: 'inplace_035_01_account_root_promotion', sql: statements[0], protocol: 'account-root-migration/v1', priorRegistryHash }
  const step = Object.freeze({ ...body, checksum: hash(body) })
  return { prior, priorRegistryHash, step, steps: [...prior.steps, step] }
}

// Journal data is validated by the complete registry, including timestamps and
// status. Its schema remains protected. All other row values remain evidence.
export function accountRootMigrationSnapshot(tables, promote = false) {
  const names = new Map(promote ? accountRootRenames : [])
  const mapped = name => names.get(name) ?? name
  const snapshot = tables.map(table => {
    check(typeof table.name === 'string' && /^[a-z][a-z0-9_]*$/.test(table.name), 'table_name')
    check(new RegExp('^CREATE TABLE `' + table.name + '` \\(').test(table.ddl), 'definition_table')
    const ddl = table.ddl.replace(/^CREATE TABLE `([a-z][a-z0-9_]*)`/, (_full, name) => `CREATE TABLE \`${mapped(name)}\``)
      .replace(/^(  CONSTRAINT `[^`]+` FOREIGN KEY \([^)]+\) REFERENCES )`([a-z][a-z0-9_]*)`/gm,
        (_full, prefix, name) => `${prefix}\`${mapped(name)}\``)
    return { name: mapped(table.name), ddlSha256: sha256(ddl), schemaSha256: tableDefinitionHash(ddl),
      ...(table.name === journalName ? {} : { rows: table.rows, rowsSha256: table.rowsSha256 }) }
  }).sort((a, b) => a.name.localeCompare(b.name))
  check(snapshot.some(row => row.name === journalName) && new Set(snapshot.map(row => row.name)).size === snapshot.length, 'snapshot_tables')
  return snapshot
}

export function prepareAccountRootMigrationProof(plan, identity, tables, tools) {
  const body = { kind: 'account-root-migration-proof/v1', identity, stepChecksum: plan.step.checksum,
    priorRegistryHash: plan.priorRegistryHash, before: accountRootMigrationSnapshot(tables), after: accountRootMigrationSnapshot(tables, true), tools }
  return { ...body, proofHash: hash(body) }
}

function validateProof(proof, plan, identity) {
  check(proof?.kind === 'account-root-migration-proof/v1', 'proof_kind')
  const { proofHash, ...body } = proof
  check(hash(body) === proofHash && hash(proof.identity) === hash(identity)
    && proof.stepChecksum === plan.step.checksum && proof.priorRegistryHash === plan.priorRegistryHash, 'proof_binding')
  check(Array.isArray(proof.before) && Array.isArray(proof.after) && proof.before.length === proof.after.length, 'proof_tables')
  for (const rows of [proof.before, proof.after]) {
    check(rows.length > 0 && new Set(rows.map(row => row.name)).size === rows.length
      && rows.some(row => row.name === journalName), 'proof_tables')
    check(rows.every(row => /^[a-z][a-z0-9_]*$/.test(row.name) && /^[a-f0-9]{64}$/.test(row.ddlSha256)
      && /^[a-f0-9]{64}$/.test(row.schemaSha256) && (row.name === journalName
        ? row.rows === undefined && row.rowsSha256 === undefined
        : Number.isSafeInteger(row.rows) && row.rows >= 0 && /^[a-f0-9]{64}$/.test(row.rowsSha256))), 'proof_snapshot')
  }
  const names = new Map(accountRootRenames)
  check(accountRootRenames.every(([before, after]) => proof.before.some(row => row.name === before)
    && proof.after.some(row => row.name === after)), 'proof_layout')
  const mapped = proof.before.map(row => ({ ...row, name: names.get(row.name) ?? row.name })).sort((a, b) => a.name.localeCompare(b.name))
  check(mapped.every((row, i) => row.name === proof.after[i].name && row.rows === proof.after[i].rows
    && row.rowsSha256 === proof.after[i].rowsSha256), 'proof_mapping')
  check(Array.isArray(proof.tools) && proof.tools.length > 0 && proof.tools.every(tool => typeof tool.path === 'string'
    && /^[a-f0-9]{64}$/.test(tool.sha256)), 'proof_tools')
}

function completedStateMatches(actual, expected) {
  const schema = rows => rows.map(({ name, schemaSha256 }) => ({ name, schemaSha256 }))
  const legacy = rows => rows.find(row => row.name === 'trading_accounts_legacy_v3')
  return hash(schema(actual)) === hash(schema(expected)) && legacy(actual)?.rows === legacy(expected)?.rows
    && legacy(actual)?.rowsSha256 === legacy(expected)?.rowsSha256
}

// Store owns a same-connection upgrade lock and a previously fsynced proof.
// verifyPrior uses the original registry before promotion and the restricted
// historical metadata adapter after promotion. It must never apply old steps.
export async function coordinateAccountRootMigration(store, plan, { apply = false } = {}) {
  const history = await store.history()
  const validated = validateColumnHistory(history, plan.steps)
  check(plan.prior.steps.every(step => validated.get(step.id)?.status === 'completed'), 'prior_incomplete')
  const proof = await store.proof()
  validateProof(proof, plan, await store.identity())
  await store.verifyTools(proof.tools)
  const priorIds = new Set(plan.prior.steps.map(step => step.id))
  const priorHistory = history.filter(row => priorIds.has(row.id))
  const entry = validated.get(plan.step.id)
  const actual = await store.snapshot()
  const before = hash(actual) === hash(proof.before), after = hash(actual) === hash(proof.after)
  if (entry?.status === 'completed') {
    check(completedStateMatches(actual, proof.after), 'completed_state_conflict')
    await store.verifyPrior('promoted', priorHistory)
    return { status: 'completed', ddlCount: 0 }
  }
  check(before || after, 'state_conflict')
  check(entry || !after, 'unrecorded_promotion')
  await store.verifyPrior(after ? 'promoted' : 'original', priorHistory)
  if (!apply) return { status: after ? 'reconcile' : 'pending', ddlCount: 0 }
  if (!entry) {
    try { await store.begin(plan.step) }
    catch { throw Error('account_root_migration_begin_unknown') }
  }
  let ddlCount = 0
  if (!after) {
    check(hash(await store.snapshot()) === hash(proof.before), 'precondition_changed')
    try { await store.execute(plan.step.sql); ddlCount++ }
    catch { throw Error('account_root_migration_ddl_unknown') }
  }
  check(hash(await store.snapshot()) === hash(proof.after), 'postcondition_failed')
  await store.verifyPrior('promoted', priorHistory)
  try { await store.complete(plan.step) }
  catch { throw Error('account_root_migration_complete_unknown') }
  return { status: after ? 'reconciled' : 'applied', ddlCount }
}
