import { expect, it, vi } from 'vitest'
import { coordinateObserverContextMigration } from '../scripts/lib/observer-context-coordinator.mjs'
import { accountRootRenames, accountRootRenameSql } from '../scripts/lib/account-root-promotion.mjs'
import { prepareAccountRootMigrationProof, accountRootMigrationSnapshot } from '../scripts/lib/inplace-account-root-migration.mjs'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'

const journal = step => ({ id: step.id, checksum: step.checksum, status: 'completed',
  startedAt: '2026-09-08T00:00:00Z', completedAt: '2026-09-08T00:00:01Z' })
const table = name => ({ name, ddl: `CREATE TABLE \`${name}\` (\n  \`id\` bigint NOT NULL\n) ENGINE=InnoDB`, rows: 0, rowsSha256: hash('empty') })
function fixture() {
  const base = { id: 'base', checksum: hash('base') }
  const rootPlan = { prior: { steps: [base] }, priorRegistryHash: hash([base]),
    step: { id: 'promotion', checksum: hash('promotion'), sql: accountRootRenameSql() } }
  rootPlan.steps = [base, rootPlan.step]
  const stepsFor = names => names.map(name => ({ id: name, table: name, checksum: hash(name) }))
  const terminal = stepsFor(['terminal_account_bindings', 'bridge_connection_sessions'])
  const prior = { prior: rootPlan, additions: terminal, steps: [...rootPlan.steps, ...terminal] }
  const additions = stepsFor(['observer_sources', 'observer_channels', 'observer_channel_accesses', 'trading_contexts'])
  const plan = { prior, additions, steps: [...prior.steps, ...additions] }
  const identity = { database: 'dev_vue', serverUuid: 'fixture' }
  const before = ['database_upgrade_steps_v4', 'users', ...accountRootRenames.map(([name]) => name)].map(table)
  const rootProof = prepareAccountRootMigrationProof(rootPlan, identity, before, [{ path: 'tool.mjs', sha256: hash('tool') }])
  const mapping = new Map(accountRootRenames)
  const oldTables = before.map(row => table(mapping.get(row.name) ?? row.name))
  const terminalTables = new Map(terminal.map(step => [step.table, { matches: true, rows: 0 }]))
  const newTables = new Map()
  let history = prior.steps.map(journal)
  const rootStore = {
    identity: async () => identity, proof: async () => rootProof,
    verifyTools: vi.fn(async () => {}), verifyPrior: vi.fn(async () => {}),
    snapshot: async () => accountRootMigrationSnapshot([...oldTables,
      ...[...terminalTables].map(([name, row]) => ({ ...table(name), rows: row.rows })),
      ...[...newTables].map(([name, row]) => ({ ...table(name), rows: row.rows }))]),
  }
  const priorStore = {
    rootStore, verifyPlan: vi.fn(async () => {}), history: async () => history,
    tableState: async step => terminalTables.get(step.table) ?? null,
    verifyProtected: vi.fn(async () => {}), begin: vi.fn(), execute: vi.fn(), complete: vi.fn(),
  }
  const frozen = accountRootMigrationSnapshot([...oldTables, ...terminal.map(step => table(step.table))])
  const store = {
    priorStore, history: async () => structuredClone(history), verifyPlan: vi.fn(async () => {}),
    tableState: vi.fn(async step => newTables.get(step.table) ?? null),
    verifyProtected: vi.fn(async snapshot => { expect(snapshot).toEqual(frozen) }),
    begin: vi.fn(async step => { history.push({ ...journal(step), status: 'started', completedAt: null }) }),
    execute: vi.fn(async step => { newTables.set(step.table, { matches: true, rows: 0 }) }),
    complete: vi.fn(async step => { history[history.findIndex(row => row.id === step.id)] = journal(step) }),
  }
  return { plan, store, priorStore, oldTables, newTables, terminalTables,
    get history() { return history }, set history(value) { history = value } }
}

it('applies four ordered steps, preserves both real historical coordinators and reenters with zero DDL', async () => {
  const f = fixture()
  expect((await coordinateObserverContextMigration(f.store, f.plan)).steps.map(s => s.status)).toEqual(Array(4).fill('pending'))
  expect(f.store.execute).not.toHaveBeenCalled()
  expect((await coordinateObserverContextMigration(f.store, f.plan, { apply: true })).ddlCount).toBe(4)
  expect(f.store.execute.mock.calls.map(([step]) => step.id)).toEqual(f.plan.additions.map(step => step.id))
  expect((await coordinateObserverContextMigration(f.store, f.plan, { apply: true })).ddlCount).toBe(0)
  expect(f.priorStore.rootStore.verifyPrior).toHaveBeenCalledWith('promoted', expect.any(Array))
  for (const action of ['begin', 'execute', 'complete']) expect(f.priorStore[action]).not.toHaveBeenCalled()
})

for (const action of ['begin', 'execute', 'complete']) it(`recovers lost ${action} response without repeating committed DDL`, async () => {
  const f = fixture(), perform = f.store[action].getMockImplementation()
  f.store[action].mockImplementationOnce(async step => { await perform(step); throw Error('response_lost') })
  await expect(coordinateObserverContextMigration(f.store, f.plan, { apply: true })).rejects.toThrow('_unknown')
  await coordinateObserverContextMigration({ ...f.store, priorStore: { ...f.priorStore } }, f.plan, { apply: true })
  expect(f.store.execute).toHaveBeenCalledTimes(4)
  expect(f.history).toEqual(f.plan.steps.map(journal))
})

for (const fault of ['unrecorded', 'schema_drift', 'early_rows', 'completed_missing', 'history_gap', 'unknown_history', 'prior_missing', 'terminal_missing', 'terminal_drift', 'legacy_rows', 'unrelated_table']) {
  it(`refuses ${fault} before any new DDL`, async () => {
    const f = fixture(), step = f.plan.additions[0]
    if (fault === 'unrecorded') f.newTables.set(step.table, { matches: true, rows: 0 })
    if (fault === 'schema_drift') f.newTables.set(step.table, { matches: false, rows: 0 })
    if (fault === 'early_rows') { await f.store.begin(step); f.newTables.set(step.table, { matches: true, rows: 1 }) }
    if (fault === 'completed_missing') f.history.push(journal(step))
    if (fault === 'history_gap') f.history.push(journal(f.plan.additions[1]))
    if (fault === 'unknown_history') f.history.push(journal({ id: 'unknown', checksum: hash('unknown') }))
    if (fault === 'prior_missing') f.history = f.history.slice(0, -1)
    if (fault === 'terminal_missing') f.terminalTables.delete('bridge_connection_sessions')
    if (fault === 'terminal_drift') f.terminalTables.get('bridge_connection_sessions').matches = false
    if (fault === 'legacy_rows') f.oldTables.find(t => t.name === 'trading_accounts_legacy_v3').rowsSha256 = hash('changed')
    if (fault === 'unrelated_table') f.oldTables.push(table('unrelated'))
    // Force historical validators to prove their own checks, independently of
    // the new adapter's still separately required frozen-row verification.
    if (['legacy_rows', 'unrelated_table', 'terminal_missing', 'terminal_drift'].includes(fault)) f.store.verifyProtected.mockResolvedValue(undefined)
    await expect(coordinateObserverContextMigration(f.store, f.plan, { apply: true })).rejects.toThrow()
    expect(f.store.execute).not.toHaveBeenCalled()
  })
}

it('does not complete new DDL after old data changes during execution', async () => {
  const f = fixture(), execute = f.store.execute.getMockImplementation()
  f.store.execute.mockImplementationOnce(async step => { await execute(step); f.oldTables.find(t => t.name === 'users').rows++ })
  await expect(coordinateObserverContextMigration(f.store, f.plan, { apply: true })).rejects.toThrow()
  expect(f.store.complete).not.toHaveBeenCalled()
})

it('validates the durable plan before any table inspection', async () => {
  const f = fixture(); f.store.verifyPlan.mockRejectedValueOnce(Error('proof_drift'))
  await expect(coordinateObserverContextMigration(f.store, f.plan, { apply: true })).rejects.toThrow('proof_drift')
  expect(f.store.tableState).not.toHaveBeenCalled()
})
