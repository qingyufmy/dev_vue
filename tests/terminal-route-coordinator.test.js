import { expect, it, vi } from 'vitest'
import { coordinateTerminalRouteMigration } from '../scripts/lib/terminal-route-coordinator.mjs'
import { accountRootRenames, accountRootRenameSql } from '../scripts/lib/account-root-promotion.mjs'
import { prepareAccountRootMigrationProof, accountRootMigrationSnapshot } from '../scripts/lib/inplace-account-root-migration.mjs'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'

const journal = step => ({ id: step.id, checksum: step.checksum, status: 'completed',
  startedAt: '2026-09-08T00:00:00Z', completedAt: '2026-09-08T00:00:01Z' })
function fixture() {
  const base = { id: 'base', checksum: hash('base') }
  const prior = { prior: { steps: [base] }, priorRegistryHash: hash([base]),
    step: { id: 'promotion', checksum: hash('promotion'), sql: accountRootRenameSql() } }
  prior.steps = [base, prior.step]
  const additions = ['terminal_account_bindings', 'bridge_connection_sessions'].map(table => ({ id: table, table, checksum: hash(table) }))
  const plan = { prior, additions, steps: [...prior.steps, ...additions] }
  const identity = { database: 'dev_vue', serverUuid: 'test-server' }
  const before = ['database_upgrade_steps_v4', 'users', ...accountRootRenames.map(([name]) => name)].map(name => ({
    name, ddl: `CREATE TABLE \`${name}\` (\n  \`id\` bigint NOT NULL\n) ENGINE=InnoDB`, rows: 3, rowsSha256: hash(name),
  }))
  const names = new Map(accountRootRenames)
  const original = before.map(row => ({ ...row, name: names.get(row.name) ?? row.name,
    ddl: row.ddl.replace(/^CREATE TABLE `([^`]+)`/, (_full, name) => `CREATE TABLE \`${names.get(name) ?? name}\``) }))
  const proof = prepareAccountRootMigrationProof(prior, identity, before, [{ path: 'tool.mjs', sha256: hash('tool') }])
  const tables = new Map()
  const frozenPrior = accountRootMigrationSnapshot(original)
  let history = prior.steps.map(journal)
  const rootStore = {
    history: async () => history, proof: async () => proof, identity: async () => identity,
    verifyTools: vi.fn(async () => {}), verifyPrior: vi.fn(async () => {}),
    snapshot: vi.fn(async () => accountRootMigrationSnapshot([...original, ...[...tables].map(([name, table]) => ({
      name, ddl: `CREATE TABLE \`${name}\` (\n  \`id\` bigint NOT NULL\n) ENGINE=InnoDB`, rows: table.rows, rowsSha256: hash(name),
    }))])),
  }
  const store = {
    rootStore, history: async () => structuredClone(history), verifyPlan: vi.fn(async () => {}),
    tableState: vi.fn(async step => tables.get(step.table) ?? null),
    verifyProtected: vi.fn(async snapshot => { expect(snapshot).toEqual(frozenPrior) }),
    begin: vi.fn(async step => { history.push({ ...journal(step), status: 'started', completedAt: null }) }),
    execute: vi.fn(async step => { tables.set(step.table, { matches: true, rows: 0 }) }),
    complete: vi.fn(async step => { history[history.findIndex(row => row.id === step.id)] = journal(step) }),
  }
  return { plan, store, tables, original, get history() { return history }, set history(value) { history = value } }
}

it('inspects without writes, applies each step and reenters with zero DDL', async () => {
  const f = fixture()
  expect((await coordinateTerminalRouteMigration(f.store, f.plan)).steps.map(row => row.status)).toEqual(['pending', 'pending'])
  expect(f.store.begin).not.toHaveBeenCalled()
  expect((await coordinateTerminalRouteMigration(f.store, f.plan, { apply: true })).ddlCount).toBe(2)
  expect((await coordinateTerminalRouteMigration(f.store, f.plan, { apply: true })).ddlCount).toBe(0)
  expect(f.store.execute).toHaveBeenCalledTimes(2)
  expect(f.store.rootStore.verifyPrior).toHaveBeenCalledWith('promoted', expect.any(Array))
})

for (const action of ['begin', 'execute', 'complete']) it(`recovers a lost ${action} response from persisted facts without replaying committed DDL`, async () => {
  const f = fixture(), original = f.store[action].getMockImplementation()
  f.store[action].mockImplementationOnce(async step => { await original(step); throw Error('response_lost') })
  await expect(coordinateTerminalRouteMigration(f.store, f.plan, { apply: true })).rejects.toThrow('_unknown')
  const nextProcess = { ...f.store, rootStore: { ...f.store.rootStore } }
  await coordinateTerminalRouteMigration(nextProcess, f.plan, { apply: true })
  expect(f.store.execute).toHaveBeenCalledTimes(2)
  expect(f.history).toEqual(f.plan.steps.map(journal))
})

it('retries an unapplied DDL only on a later invocation after fresh inspection', async () => {
  const f = fixture()
  f.store.execute.mockRejectedValueOnce(Error('not_applied'))
  await expect(coordinateTerminalRouteMigration(f.store, f.plan, { apply: true })).rejects.toThrow('ddl_unknown')
  expect(f.store.execute).toHaveBeenCalledTimes(1)
  await coordinateTerminalRouteMigration(f.store, f.plan, { apply: true })
  expect(f.store.execute).toHaveBeenCalledTimes(3)
})

for (const fault of ['unrecorded', 'mismatch', 'early_rows', 'completed_missing', 'unknown_history', 'history_gap', 'prior_missing']) {
  it(`refuses ${fault} before changing any tables`, async () => {
    const f = fixture(), step = f.plan.additions[0]
    if (fault === 'unrecorded') f.tables.set(step.table, { matches: true, rows: 0 })
    if (fault === 'mismatch') f.tables.set(step.table, { matches: false, rows: 0 })
    if (fault === 'early_rows') { await f.store.begin(step); f.tables.set(step.table, { matches: true, rows: 1 }) }
    if (fault === 'completed_missing') f.history.push(journal(step))
    if (fault === 'unknown_history') f.history.push(journal({ id: 'unknown', checksum: hash('unknown') }))
    if (fault === 'history_gap') f.history.push(journal(f.plan.additions[1]))
    if (fault === 'prior_missing') f.history = [f.history[0]]
    await expect(coordinateTerminalRouteMigration(f.store, f.plan, { apply: true })).rejects.toThrow()
    expect(f.store.execute).not.toHaveBeenCalled()
  })
}

it('still rejects an unrelated added table through the original root validator', async () => {
  const f = fixture()
  f.store.verifyProtected.mockResolvedValue(undefined)
  f.original.push({ name: 'unexpected', ddl: 'CREATE TABLE `unexpected` (\n  `id` bigint NOT NULL\n) ENGINE=InnoDB', rows: 0, rowsSha256: hash('empty') })
  await expect(coordinateTerminalRouteMigration(f.store, f.plan, { apply: true })).rejects.toThrow('completed_state_conflict')
  expect(f.store.execute).not.toHaveBeenCalled()
})

it('does not complete a step if protected prior data changed during its DDL', async () => {
  const f = fixture(), execute = f.store.execute.getMockImplementation()
  f.store.execute.mockImplementationOnce(async step => {
    await execute(step)
    f.original.find(table => table.name === 'users').rowsSha256 = hash('changed')
  })
  await expect(coordinateTerminalRouteMigration(f.store, f.plan, { apply: true })).rejects.toThrow()
  expect(f.store.complete).not.toHaveBeenCalled()
  expect(f.store.execute).toHaveBeenCalledOnce()
})

it('requires the durable plan check before inspection and permits normal rows only after completed steps', async () => {
  const f = fixture()
  f.store.verifyPlan.mockRejectedValueOnce(Error('proof_mismatch'))
  await expect(coordinateTerminalRouteMigration(f.store, f.plan, { apply: true })).rejects.toThrow('proof_mismatch')
  expect(f.store.tableState).not.toHaveBeenCalled()
  await coordinateTerminalRouteMigration(f.store, f.plan, { apply: true })
  for (const table of f.tables.values()) table.rows = 2
  expect((await coordinateTerminalRouteMigration(f.store, f.plan, { apply: true })).ddlCount).toBe(0)
  expect(f.store.verifyProtected).toHaveBeenLastCalledWith(expect.any(Array), true)
})
