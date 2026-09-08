import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'

const bridge = vi.hoisted(() => ({ root: null, begin: vi.fn(), complete: vi.fn() }))
vi.mock('../scripts/lib/mysql-account-root-migration.mjs', async importOriginal => ({
  ...await importOriginal(),
  mysqlAccountRootMigrationStore: vi.fn(async () => bridge.root),
  freezeAccountRootMigrationTools: async () => [{ path: 'root.mjs', sha256: 'a'.repeat(64) }],
}))
vi.mock('../scripts/lib/mysql-inplace-column-store.mjs', () => ({
  mysqlColumnStore: () => ({ begin: bridge.begin, complete: bridge.complete }),
}))
import { freezeTerminalRouteTools, prepareTerminalRouteProof, validateTerminalRouteProof,
  persistTerminalRouteProof, mysqlTerminalRouteMigrationStore } from '../scripts/lib/mysql-terminal-route-migration.mjs'

const root = new URL('../', import.meta.url)
const dirs = []
afterEach(async () => { vi.clearAllMocks(); await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true }))) })
async function fixture() {
  const identity = { database: 'dev_vue', serverUuid: 'fixture' }
  const priorSnapshot = [{ name: 'users', ddlSha256: hash('ddl'), schemaSha256: hash('schema'), rows: 3, rowsSha256: hash('rows') }]
  const rootProof = { identity, proofHash: hash('root'), after: priorSnapshot }
  const additions = ['terminal_account_bindings', 'bridge_connection_sessions'].map(table => ({
    id: table, table, sql: `CREATE TABLE \`${table}\` (\`id\` bigint NOT NULL)`, checksum: hash(table),
  }))
  const plan = { prior: {}, additions, steps: additions }
  const definitions = additions.map(step => ({ table: step.table, sourceSqlHash: hash(step.sql), ddl: step.sql }))
  const tools = await freezeTerminalRouteTools(root)
  const proof = prepareTerminalRouteProof(plan, identity, rootProof, priorSnapshot, definitions, tools)
  const directory = await mkdtemp(join(tmpdir(), 'terminal-route-test-')); dirs.push(directory)
  const proofPath = join(directory, 'proof.json'), rootPath = join(directory, 'root.json')
  await persistTerminalRouteProof(proofPath, proof)
  bridge.root = { identity: vi.fn(async () => identity), proof: async () => rootProof, history: vi.fn(async () => []) }
  const connection = { execute: vi.fn(async () => [[{ tableType: 'BASE TABLE' }]]), query: vi.fn(async sql =>
    sql.startsWith('SHOW') ? [[{ 'Create Table': definitions[0].ddl }]] : [[{ rowCount: '0' }]]) }
  const open = () => mysqlTerminalRouteMigrationStore(connection, plan, root, proofPath, rootPath)
  return { identity, priorSnapshot, rootProof, plan, definitions, tools, proof, proofPath, connection, open }
}
const resign = proof => { const { proofHash, ...body } = proof; return { ...body, proofHash: hash(body) } }

it('binds definitions, registry, identity and copied snapshots to the persisted proof', async () => {
  const f = await fixture()
  expect(() => validateTerminalRouteProof(f.proof, f.plan, f.identity, f.rootProof)).not.toThrow()
  f.priorSnapshot[0].rows++
  expect(f.proof.priorSnapshot[0].rows).toBe(3)
  expect(JSON.parse(await readFile(f.proofPath, 'utf8'))).toEqual(f.proof)
  await expect(persistTerminalRouteProof(f.proofPath, { overwritten: true })).rejects.toMatchObject({ code: 'EEXIST' })
  expect(JSON.parse(await readFile(f.proofPath, 'utf8'))).toEqual(f.proof)
})

for (const [field, change, error] of [
  ['identity', p => { p.identity.database = 'other' }, 'proof_identity'],
  ['root', p => { p.rootProofHash = hash('other') }, 'proof_identity'],
  ['registry', p => { p.registryHash = hash('other') }, 'registry'],
  ['tables', p => { p.priorSnapshot.push(p.priorSnapshot[0]) }, 'prior_tables'],
  ['rows', p => { p.priorSnapshot[0].rows = -1 }, 'prior_snapshot'],
  ['source', p => { p.definitions[0].sourceSqlHash = hash('other') }, 'definition_binding'],
  ['DDL', p => { p.definitions[0].ddl += ' ENGINE=InnoDB' }, 'definition_binding'],
  ['tools', p => { p.tools.push(p.tools[0]) }, 'tools'],
]) it(`rejects a rehashed proof with invalid ${field}`, async () => {
  const f = await fixture(), invalid = structuredClone(f.proof); change(invalid)
  expect(() => validateTerminalRouteProof(resign(invalid), f.plan, f.identity, f.rootProof)).toThrow(error)
})

it('refuses malformed definitions and snapshots before preparing a plan', async () => {
  const f = await fixture()
  f.definitions[0].ddl = null
  expect(() => prepareTerminalRouteProof(f.plan, f.identity, f.rootProof, f.priorSnapshot, f.definitions, f.tools)).toThrow('definition_binding')
  f.definitions[0].ddl = f.plan.additions[0].sql
  delete f.priorSnapshot[0].rowsSha256
  expect(() => prepareTerminalRouteProof(f.plan, f.identity, f.rootProof, f.priorSnapshot, f.definitions, f.tools)).toThrow('prior_snapshot')
})

it('checks canonical DDL, missing tables and views without mutating the database', async () => {
  const f = await fixture(), store = await f.open(), step = f.plan.additions[0]
  expect(await store.tableState(step)).toEqual({ matches: true, rows: 0 })
  f.connection.execute.mockResolvedValueOnce([[]])
  expect(await store.tableState(step)).toBeNull()
  f.connection.execute.mockResolvedValueOnce([[{ tableType: 'VIEW' }]])
  expect(await store.tableState(step)).toEqual({ matches: false, rows: 0 })
  f.connection.query.mockResolvedValueOnce([[{ 'Create Table': step.sql.replace('bigint', 'int') }]])
  expect(await store.tableState(step)).toEqual({ matches: false, rows: 0 })
  expect(bridge.begin).not.toHaveBeenCalled(); expect(bridge.complete).not.toHaveBeenCalled()
})

it('requires unchanged old rows until completion and unchanged schema afterwards', async () => {
  const f = await fixture(), store = await f.open(), changed = structuredClone(f.proof.priorSnapshot)
  changed[0].rows++
  await expect(store.verifyProtected(changed, false)).rejects.toThrow('protected_rows_changed')
  await expect(store.verifyProtected(changed, true)).resolves.toBeUndefined()
  changed[0].schemaSha256 = hash('different')
  await expect(store.verifyProtected(changed, true)).rejects.toThrow('protected_schema_changed')
})

it('checks step and same-connection identity before every journal or DDL mutation', async () => {
  const f = await fixture(), store = await f.open(), step = f.plan.additions[0]
  for (const action of ['begin', 'execute', 'complete']) {
    await expect(store[action]({ ...step, sql: 'DROP TABLE users' })).rejects.toThrow('_step')
    bridge.root.identity.mockRejectedValueOnce(Error('account_root_store_lock_lost'))
    await expect(store[action](step)).rejects.toThrow('lock_lost')
  }
  expect(bridge.begin).not.toHaveBeenCalled(); expect(bridge.complete).not.toHaveBeenCalled()
  expect(f.connection.query).not.toHaveBeenCalled()
  await store.begin(step); await store.execute(step); await store.complete(step)
  expect(bridge.begin).toHaveBeenCalledWith(step); expect(bridge.complete).toHaveBeenCalledWith(step)
  expect(f.connection.query).toHaveBeenCalledExactlyOnceWith(step.sql)
})

it('rejects unbound tool manifests when opening the adapter', async () => {
  const f = await fixture(), path = join(dirs.at(-1), 'bad.json')
  f.proof.tools.pop()
  await persistTerminalRouteProof(path, resign(f.proof))
  await expect(mysqlTerminalRouteMigrationStore(f.connection, f.plan, root, path, join(dirs.at(-1), 'root.json'))).rejects.toThrow('_tools')
  expect(f.connection.query).not.toHaveBeenCalled()
})
