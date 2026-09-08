import { tableDefinitionHash } from '../scripts/lib/inplace-foundation-upgrade.mjs'
import { promotedLegacyCandlePriorStore } from '../scripts/lib/legacy-candle-historical-store.mjs'
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
  const base = { id: 'base', table: 'market_candles', checksum: hash('base') }
  const rootPlan = { prior: { steps: [base], transitions: [{ step: base, key: 'market_candles', before: null, after: tableDefinitionHash(table('market_candles').ddl) }], store: connection => ({ tableHash: async name => tableDefinitionHash((await connection.query('SHOW CREATE TABLE `' + name + '`'))[0][0]['Create Table']) }) }, priorRegistryHash: hash([base]),
    step: { id: 'promotion', checksum: hash('promotion'), sql: accountRootRenameSql() } }
  rootPlan.steps = [base, rootPlan.step]
  const stepsFor = names => names.map(name => ({ id: name, table: name, checksum: hash(name) }))
  const terminal = stepsFor(['terminal_account_bindings', 'bridge_connection_sessions'])
  const prior = { prior: rootPlan, additions: terminal, steps: [...rootPlan.steps, ...terminal] }
  const additions = stepsFor(['observer_sources', 'observer_channels', 'observer_channel_accesses', 'trading_contexts'])
  const plan = { prior, additions, steps: [...prior.steps, ...additions] }
  const identity = { database: 'dev_vue', serverUuid: 'fixture' }
  const before = ['database_upgrade_steps_v4', 'users', 'market_candles', 'market_data_sources', ...accountRootRenames.map(([name]) => name)].map(table)
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
  const additions = names.map(name => ({ id: name, table: name, sql: table(name).ddl, checksum: hash(name) }))
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


async function promotedFixture() {
  const f = await candleFixture()
  await coordinateLegacyCandleBuildMigration(f.store, f.plan, { apply: true })
  const rootStore = f.old.old.priorStore.rootStore
  const normalized = await rootStore.snapshot()
  const raw = normalized.map(row => ({ ...table(row.name), ...row }))
  const actual = raw.map(row => {
    const name = row.name === 'market_candles' ? 'market_candles_legacy_v3' : row.name === 'market_candles_build_v4' ? 'market_candles' : row.name
    return { ...row, name, ddl: row.ddl.replace('`' + row.name + '`', '`' + name + '`') }
  })
  const connection = { query: vi.fn(async sql => {
    if (sql.startsWith('SELECT TABLE_NAME')) return [actual.map(row => ({ name: row.name, kind: 'BASE TABLE' }))]
    if (sql.startsWith('SHOW CREATE TABLE')) {
      const name = /`([^`]+)`/.exec(sql)[1], row = actual.find(row => row.name === name)
      return row ? [[{ Table: name, 'Create Table': row.ddl }]] : [[]]
    }
    throw Error('unexpected_sql')
  }) }
  const definitions = f.plan.additions.map(step => ({ table: step.table, sourceSqlHash: hash(step.sql), ddl: step.sql, schemaHash: tableDefinitionHash(step.sql) }))
  for (const stage of [f.store, f.old.store, f.old.old.store, f.old.old.priorStore]) for (const action of ['begin', 'execute', 'complete']) stage[action].mockClear()
  return { f, connection, actual, definitions, open: () => promotedLegacyCandlePriorStore(connection, f.store, f.plan, f.old.old.history, actual, definitions) }
}

it('runs every existing coordinator through the projected snapshot and actual old metadata verifier', async () => {
  const { f, connection, open } = await promotedFixture()
  const store = await open(), result = await coordinateLegacyCandleBuildMigration(store, f.plan)
  expect(result.steps.every(row => row.status === 'completed')).toBe(true)
  expect(connection.query).toHaveBeenCalledWith('SHOW CREATE TABLE `market_candles_legacy_v3`')
  for (const stage of [f.store, f.old.store, f.old.old.store, f.old.old.priorStore]) {
    for (const action of ['begin', 'execute', 'complete']) expect(stage[action]).not.toHaveBeenCalled()
  }
  const stages = [store, store.priorStore, store.priorStore.priorStore, store.priorStore.priorStore.priorStore, store.priorStore.priorStore.priorStore.rootStore]
  for (const stage of stages) for (const action of ['begin', 'execute', 'complete']) expect(() => stage[action]()).toThrow('write_forbidden')
})

for (const name of ['market_candles', 'market_candles_legacy_v3', 'legacy_candle_mappings_v4']) it(`retains schema drift detection for ${name}`, async () => {
  const { f, actual, open } = await promotedFixture()
  actual.find(row => row.name === name).ddl = actual.find(row => row.name === name).ddl.replace('bigint', 'int')
  const store = await open()
  await expect(coordinateLegacyCandleBuildMigration(store, f.plan)).rejects.toThrow()
})

it('rejects a mixed table layout or incomplete/unknown historical journal before delegation', async () => {
  const { f, actual, open } = await promotedFixture()
  actual.push(table('market_candles_build_v4'))
  await expect(open()).rejects.toThrow('layout')
  actual.pop()
  f.old.old.history.push(journal({ id: 'unknown', checksum: hash('unknown') }))
  await expect(open()).rejects.toThrow()
  f.old.old.history.pop(); f.old.old.history.pop()
  await expect(open()).rejects.toThrow('incomplete')
})

it('refuses altered canonical definitions and does not hide failed legacy metadata checks', async () => {
  const { f, definitions, open, connection } = await promotedFixture()
  definitions[0].sourceSqlHash = hash('changed')
  await expect(open()).rejects.toThrow('definition_binding')
  definitions[0].sourceSqlHash = hash(f.plan.additions[0].sql)
  const store = await open(), query = connection.query.getMockImplementation()
  connection.query.mockImplementation(async sql => sql === 'SHOW CREATE TABLE `market_candles_legacy_v3`'
    ? [[{ 'Create Table': table('market_candles_legacy_v3').ddl.replace('bigint', 'int') }]] : query(sql))
  await expect(coordinateLegacyCandleBuildMigration(store, f.plan)).rejects.toThrow('schema_conflict')
})
