import { coordinateLegacyCandleBuildMigration } from '../scripts/lib/legacy-candle-build-coordinator.mjs'
import { coordinateAccountProjectionMigration } from '../scripts/lib/account-projection-coordinator.mjs'
import { accountProjectionTables } from '../scripts/lib/inplace-account-projection-migration.mjs'
import { expect, it, vi } from 'vitest'
import { coordinateObserverContextMigration } from '../scripts/lib/observer-context-coordinator.mjs'
import { accountRootRenames, accountRootRenameSql } from '../scripts/lib/account-root-promotion.mjs'
import { prepareAccountRootMigrationProof, accountRootMigrationSnapshot } from '../scripts/lib/inplace-account-root-migration.mjs'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'

const journal = step => ({ id: step.id, checksum: step.checksum, status: 'completed',
  startedAt: '2026-09-08T00:00:00Z', completedAt: '2026-09-08T00:00:01Z' })
const table = name => ({ name, ddl: `CREATE TABLE \`${name}\` (\n  \`id\` bigint NOT NULL\n) ENGINE=InnoDB`, rows: 0, rowsSha256: hash('empty') })
function observerFixture() {
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

async function fixture() {
  const old = observerFixture()
  await coordinateObserverContextMigration(old.store, old.plan, { apply: true })
  for (const action of ['begin', 'execute', 'complete']) old.store[action].mockClear()
  const additions = accountProjectionTables.map(name => ({ id: name, table: name, checksum: hash(name) }))
  const plan = { prior: old.plan, additions, steps: [...old.plan.steps, ...additions] }
  const newTables = new Map()
  const rootStore = old.priorStore.rootStore, read = rootStore.snapshot
  const frozen = await read()
  rootStore.snapshot = async () => [...await read(), ...accountRootMigrationSnapshot([
    table('database_upgrade_steps_v4'), ...[...newTables].map(([name, row]) => ({ ...table(name), rows: row.rows })),
  ]).filter(row => row.name !== 'database_upgrade_steps_v4')].sort((a, b) => a.name.localeCompare(b.name))
  const store = {
    priorStore: old.store, history: async () => structuredClone(old.history), verifyPlan: vi.fn(async () => {}),
    tableState: vi.fn(async step => newTables.get(step.table) ?? null),
    verifyProtected: vi.fn(async snapshot => { expect(snapshot).toEqual(frozen) }),
    begin: vi.fn(async step => { old.history.push({ ...journal(step), status: 'started', completedAt: null }) }),
    execute: vi.fn(async step => { newTables.set(step.table, { matches: true, rows: 0 }) }),
    complete: vi.fn(async step => { old.history[old.history.findIndex(row => row.id === step.id)] = journal(step) }),
  }
  return { old, plan, store, newTables }
}


async function candleFixture() {
  const old = await fixture()
  await coordinateAccountProjectionMigration(old.store, old.plan, { apply: true })
  for (const action of ['begin', 'execute', 'complete']) old.store[action].mockClear()
  const names = ['legacy_candle_backfill_v4', 'market_candles_build_v4', 'legacy_candle_mappings_v4']
  const additions = names.map(table => ({ id: table, table, checksum: hash(table) }))
  const plan = { prior: old.plan, additions, steps: [...old.plan.steps, ...additions] }
  const newTables = new Map(), rootStore = old.old.priorStore.rootStore, read = rootStore.snapshot
  const frozen = await read()
  rootStore.snapshot = async () => [...await read(), ...accountRootMigrationSnapshot([
    table('database_upgrade_steps_v4'), ...[...newTables].map(([name, row]) => ({ ...table(name), rows: row.rows })),
  ]).filter(row => row.name !== 'database_upgrade_steps_v4')].sort((a, b) => a.name.localeCompare(b.name))
  const store = {
    priorStore: old.store, history: async () => structuredClone(old.old.history), verifyPlan: vi.fn(async () => {}),
    tableState: vi.fn(async step => newTables.get(step.table) ?? null),
    verifyProtected: vi.fn(async snapshot => { expect(snapshot).toEqual(frozen) }),
    begin: vi.fn(async step => { old.old.history.push({ ...journal(step), status: 'started', completedAt: null }) }),
    execute: vi.fn(async step => { newTables.set(step.table, { matches: true, rows: 0 }) }),
    complete: vi.fn(async step => { old.old.history[old.old.history.findIndex(row => row.id === step.id)] = journal(step) }),
  }
  return { old, plan, store, newTables }
}

it('runs three steps in order with real prior coordinators and never replays historical writes', async () => {
  const f = await candleFixture()
  expect((await coordinateLegacyCandleBuildMigration(f.store, f.plan)).steps.map(row => row.status)).toEqual(['pending', 'pending', 'pending'])
  expect(f.store.execute).not.toHaveBeenCalled()
  expect((await coordinateLegacyCandleBuildMigration(f.store, f.plan, { apply: true })).ddlCount).toBe(3)
  expect((await coordinateLegacyCandleBuildMigration(f.store, f.plan, { apply: true })).ddlCount).toBe(0)
  expect(f.store.execute.mock.calls.map(([step]) => step.id)).toEqual(f.plan.additions.map(step => step.id))
  for (const oldStore of [f.old.store, f.old.old.store, f.old.old.priorStore]) {
    for (const action of ['begin', 'execute', 'complete']) expect(oldStore[action]).not.toHaveBeenCalled()
  }
  expect(f.old.old.priorStore.rootStore.verifyPrior).toHaveBeenCalledWith('promoted', expect.any(Array))
})

for (const action of ['begin', 'execute', 'complete']) it(`recovers ${action} acknowledgement loss without repeating DDL`, async () => {
  const f = await candleFixture(), run = f.store[action].getMockImplementation()
  f.store[action].mockImplementationOnce(async step => { await run(step); throw Error('lost') })
  await expect(coordinateLegacyCandleBuildMigration(f.store, f.plan, { apply: true })).rejects.toThrow('_unknown')
  await coordinateLegacyCandleBuildMigration({ ...f.store }, f.plan, { apply: true })
  expect(f.store.execute).toHaveBeenCalledTimes(3)
  expect(f.old.old.history).toEqual(f.plan.steps.map(journal))
})

for (const fault of ['unrecorded', 'schema_drift', 'early_rows', 'completed_missing', 'unknown_history', 'history_gap',
  'prior_missing', 'projection_missing', 'projection_drift', 'observer_missing', 'terminal_missing', 'legacy_rows', 'unrelated_table']) {
  it(`rejects ${fault} before DDL`, async () => {
    const f = await candleFixture(), step = f.plan.additions[0], old = f.old.old
    if (fault === 'unrecorded') f.newTables.set(step.table, { matches: true, rows: 0 })
    if (fault === 'schema_drift') f.newTables.set(step.table, { matches: false, rows: 0 })
    if (fault === 'early_rows') { await f.store.begin(step); f.newTables.set(step.table, { matches: true, rows: 1 }) }
    if (fault === 'completed_missing') old.history.push(journal(step))
    if (fault === 'unknown_history') old.history.push(journal({ id: 'unknown', checksum: hash('unknown') }))
    if (fault === 'history_gap') old.history.push(journal(f.plan.additions[1]))
    if (fault === 'prior_missing') old.history = old.history.slice(0, -1)
    if (fault === 'projection_missing') f.old.newTables.delete('market_quotes')
    if (fault === 'projection_drift') f.old.newTables.get('market_quotes').matches = false
    if (fault === 'observer_missing') old.newTables.delete('observer_sources')
    if (fault === 'terminal_missing') old.terminalTables.delete('terminal_account_bindings')
    if (fault === 'legacy_rows') old.oldTables.find(row => row.name === 'trading_accounts_legacy_v3').rows++
    if (fault === 'unrelated_table') old.oldTables.push(table('unknown'))
    // Leave semantic validation to the real nested coordinators, not fixture hashes.
    for (const oldStore of [f.store, f.old.store, old.store]) oldStore.verifyProtected.mockResolvedValue(undefined)
    await expect(coordinateLegacyCandleBuildMigration(f.store, f.plan, { apply: true })).rejects.toThrow()
    expect(f.store.execute).not.toHaveBeenCalled()
  })
}

it('checks plan first and stops when old rows change during new DDL', async () => {
  const f = await candleFixture()
  f.store.verifyPlan.mockRejectedValueOnce(Error('plan_changed'))
  await expect(coordinateLegacyCandleBuildMigration(f.store, f.plan, { apply: true })).rejects.toThrow('plan_changed')
  expect(f.store.tableState).not.toHaveBeenCalled()
  const run = f.store.execute.getMockImplementation()
  f.store.execute.mockImplementationOnce(async step => { await run(step); f.old.old.oldTables.find(row => row.name === 'users').rows++ })
  await expect(coordinateLegacyCandleBuildMigration(f.store, f.plan, { apply: true })).rejects.toThrow()
  expect(f.store.complete).not.toHaveBeenCalled()
})

it('accepts filled build tables only after all CREATE steps complete', async () => {
  const f = await candleFixture()
  await coordinateLegacyCandleBuildMigration(f.store, f.plan, { apply: true })
  for (const row of f.newTables.values()) row.rows = 3
  expect((await coordinateLegacyCandleBuildMigration(f.store, f.plan, { apply: true })).ddlCount).toBe(0)
  expect(f.store.verifyProtected).toHaveBeenLastCalledWith(expect.any(Array), true)
})
