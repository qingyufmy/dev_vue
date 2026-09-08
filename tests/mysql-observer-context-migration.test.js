import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'
import { tableDefinitionHash } from '../scripts/lib/inplace-foundation-upgrade.mjs'

const mock = vi.hoisted(() => ({ prior: null, reference: null, begin: vi.fn(), complete: vi.fn() }))
vi.mock('node:fs/promises', async original => {
  const fs = await original()
  return { ...fs, readFile: async (path, ...args) => String(path).endsWith('/observer-context-reference-20260908.json') && mock.reference
    ? JSON.stringify(mock.reference) : fs.readFile(path, ...args) }
})
vi.mock('../scripts/lib/mysql-terminal-route-migration.mjs', () => ({
  mysqlTerminalRouteMigrationStore: async () => mock.prior,
  freezeTerminalRouteTools: async () => [{ path: 'prior.mjs', sha256: 'a'.repeat(64) }],
}))
vi.mock('../scripts/lib/mysql-inplace-column-store.mjs', () => ({ mysqlColumnStore: () => ({ begin: mock.begin, complete: mock.complete }) }))
import { prepareObserverContextProof, validateObserverContextProof, persistObserverContextProof,
  freezeObserverContextTools, mysqlObserverContextMigrationStore } from '../scripts/lib/mysql-observer-context-migration.mjs'

const root = new URL('../', import.meta.url), directories = []
const signed = body => ({ ...body, proofHash: hash(body) })
const resign = value => { const { proofHash, ...body } = value; return signed(body) }
afterEach(async () => { vi.clearAllMocks(); mock.reference = null; await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true }))) })
async function fixture() {
  const identity = { database: 'dev_vue', serverUuid: 'fixture' }
  const snapshot = [{ name: 'users', ddlSha256: hash('ddl'), schemaSha256: hash('schema'), rows: 2, rowsSha256: hash('rows') }]
  const priorProof = { identity, proofHash: hash('prior'), priorSnapshot: snapshot, definitions: [] }
  const additions = ['observer_sources', 'observer_channels', 'observer_channel_accesses', 'trading_contexts'].map(table => ({
    table, id: table, checksum: hash(table), sql: `CREATE TABLE \`${table}\` (\`id\` bigint NOT NULL)` }))
  const plan = { prior: {}, steps: additions, additions }
  const reference = signed({ kind: 'observer-context-reference/v1', identity, priorProofHash: priorProof.proofHash,
    registryHash: hash(plan.steps.map(({ id, checksum }) => ({ id, checksum }))), sourceSnapshotHash: hash(snapshot),
    referenceRemoved: true, sourceWritten: false, definitions: additions.map(step => ({ table: step.table, sourceSqlHash: hash(step.sql), ddl: step.sql, schemaHash: tableDefinitionHash(step.sql) })) })
  mock.reference = reference
  const tools = await freezeObserverContextTools(root)
  const proof = prepareObserverContextProof(plan, identity, priorProof, snapshot, reference, tools)
  const directory = await mkdtemp(join(tmpdir(), 'observer-adapter-test-')); directories.push(directory)
  const path = join(directory, 'proof.json'), priorPath = join(directory, 'prior.json'), rootPath = join(directory, 'root.json')
  await persistObserverContextProof(path, proof); await persistObserverContextProof(priorPath, priorProof)
  mock.prior = { rootStore: { identity: vi.fn(async () => identity), history: vi.fn(async () => []) } }
  const connection = { execute: vi.fn(async () => [[{ tableType: 'BASE TABLE' }]]), query: vi.fn(async sql => sql.startsWith('SHOW')
    ? [[{ 'Create Table': additions[0].sql }]] : [[{ rowCount: '0' }]]) }
  return { plan, identity, priorProof, snapshot, reference, tools, proof, path, connection,
    open: () => mysqlObserverContextMigrationStore(connection, plan, root, path, priorPath, rootPath) }
}

it('prepares an independent snapshot and refuses to overwrite the durable plan', async () => {
  const f = await fixture(); f.snapshot[0].rows++
  expect(f.proof.priorSnapshot[0].rows).toBe(2)
  await expect(persistObserverContextProof(f.path, {})).rejects.toMatchObject({ code: 'EEXIST' })
})

for (const [name, alter, code] of [
  ['identity', p => { p.identity.database = 'other' }, 'proof_identity'],
  ['prior proof', p => { p.priorProofHash = hash('other') }, 'proof_identity'],
  ['registry', p => { p.registryHash = hash('other') }, 'registry'],
  ['prior tables', p => { p.priorSnapshot.push(p.priorSnapshot[0]) }, 'prior_tables'],
  ['prior data', p => { p.priorSnapshot[0].rows = -1 }, 'prior_snapshot'],
  ['canonical DDL', p => { p.definitions[0].ddl += ' ENGINE=InnoDB' }, 'definition_binding'],
]) it(`rejects rehashed ${name} drift`, async () => {
  const f = await fixture(), bad = structuredClone(f.proof); alter(bad)
  expect(() => validateObserverContextProof(resign(bad), f.plan, f.identity, f.priorProof)).toThrow(code)
})

it('requires reference integrity and source snapshot binding before preparing', async () => {
  const f = await fixture(), reference = structuredClone(f.reference)
  reference.sourceSnapshotHash = hash('other')
  expect(() => prepareObserverContextProof(f.plan, f.identity, f.priorProof, f.snapshot, reference, f.tools)).toThrow('reference_hash')
  expect(() => prepareObserverContextProof(f.plan, f.identity, f.priorProof, f.snapshot, resign(reference), f.tools)).toThrow('reference_binding')
})

it('checks canonical schemas and holds old rows until completion', async () => {
  const f = await fixture(), store = await f.open(), step = f.plan.additions[0]
  expect(await store.tableState(step)).toEqual({ matches: true, rows: 0 })
  f.connection.execute.mockResolvedValueOnce([[]]); expect(await store.tableState(step)).toBeNull()
  f.connection.execute.mockResolvedValueOnce([[{ tableType: 'VIEW' }]]); expect((await store.tableState(step)).matches).toBe(false)
  const changed = structuredClone(f.proof.priorSnapshot); changed[0].rows++
  await expect(store.verifyProtected(changed, false)).rejects.toThrow('protected_rows_changed')
  await expect(store.verifyProtected(changed, true)).resolves.toBeUndefined()
  changed[0].schemaSha256 = hash('other')
  await expect(store.verifyProtected(changed, true)).rejects.toThrow('protected_schema_changed')
})

it('rejects changed steps and lost connection locks before all mutations', async () => {
  const f = await fixture(), store = await f.open(), step = f.plan.additions[0]
  for (const action of ['begin', 'execute', 'complete']) {
    await expect(store[action]({ ...step, sql: 'DROP TABLE users' })).rejects.toThrow('_step')
    mock.prior.rootStore.identity.mockRejectedValueOnce(Error('lock_lost'))
    await expect(store[action](step)).rejects.toThrow('lock_lost')
  }
  expect(mock.begin).not.toHaveBeenCalled(); expect(mock.complete).not.toHaveBeenCalled(); expect(f.connection.query).not.toHaveBeenCalled()
  await store.begin(step); await store.execute(step); await store.complete(step)
  expect(f.connection.query).toHaveBeenCalledExactlyOnceWith(step.sql)
})
