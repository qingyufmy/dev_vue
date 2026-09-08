import { expect, it, vi } from 'vitest'
import { mkdtemp, readFile, unlink, rmdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { persistAccountRootMigrationProof, mysqlAccountRootMigrationStore, freezeAccountRootMigrationTools, verifyAccountRootMigrationTools } from '../scripts/lib/mysql-account-root-migration.mjs'

const mocks = vi.hoisted(() => ({ verifyJournal: vi.fn(async () => true), begin: vi.fn(async () => {}), complete: vi.fn(async () => {}), history: vi.fn(async () => []) }))
vi.mock('../scripts/lib/mysql-inplace-column-store.mjs', () => ({ verifyInplaceJournal: mocks.verifyJournal,
  mysqlColumnStore: () => ({ begin: mocks.begin, complete: mocks.complete, history: mocks.history }) }))
const root = new URL('../', import.meta.url)
const plan = { step: { id: 'promotion', checksum: 'fixed', sql: 'RENAME TABLE a TO b' } }
async function withProof(work) {
  const directory = await mkdtemp(join(tmpdir(), 'aurum-root-proof-')), path = join(directory, 'proof.json')
  try { await work(path) } finally { await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error }); await rmdir(directory) }
}
const proof = { identity: { database: 'dev_vue', serverUuid: 'expected-server' } }
function connection() {
  const row = { db: 'dev_vue', uuid: 'expected-server', connectionId: 12, lockOwner: 12, autoCommit: 1, timeZone: '+00:00' }
  return { row, execute: vi.fn(async () => [[row]]), query: vi.fn(async () => []) }
}

it('persists a readable proof and never overwrites an existing plan', async () => {
  await withProof(async path => {
    await persistAccountRootMigrationProof(path, proof)
    await expect(persistAccountRootMigrationProof(path, { replacement: true })).rejects.toMatchObject({ code: 'EEXIST' })
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(proof)
  })
  await expect(persistAccountRootMigrationProof('relative.json', proof)).rejects.toThrow('proof_path')
})
it('requires a persisted proof and the owning connection before constructing a store', async () => {
  await withProof(async path => {
    const db = connection()
    await expect(mysqlAccountRootMigrationStore(db, plan, root, path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(db.execute).not.toHaveBeenCalled()
    await persistAccountRootMigrationProof(path, proof)
    for (const [key, value] of [['db', 'elsewhere'], ['uuid', 'wrong'], ['lockOwner', null], ['lockOwner', 15], ['autoCommit', 0], ['timeZone', 'SYSTEM']]) {
      const invalid = connection(); invalid.row[key] = value
      await expect(mysqlAccountRootMigrationStore(invalid, plan, root, path)).rejects.toThrow('account_root_store_')
      expect(invalid.query).not.toHaveBeenCalled()
    }
  })
})
it('rechecks lock ownership before every mutation and only allows its fixed step and SQL', async () => {
  await withProof(async path => {
    await persistAccountRootMigrationProof(path, proof)
    const db = connection(), store = await mysqlAccountRootMigrationStore(db, plan, root, path)
    await expect(store.execute('DROP TABLE users')).rejects.toThrow('sql')
    await expect(store.begin({ ...plan.step, checksum: 'changed' })).rejects.toThrow('step')
    expect(db.query).not.toHaveBeenCalled()
    await store.execute(plan.step.sql)
    expect(db.query).toHaveBeenCalledExactlyOnceWith(plan.step.sql)
    db.row.lockOwner = 22
    for (const [method, input] of [['begin', plan.step], ['execute', plan.step.sql], ['complete', plan.step]]) {
      await expect(store[method](input)).rejects.toThrow('lock_lost')
    }
    expect(db.query).toHaveBeenCalledOnce()
    expect(mocks.begin).not.toHaveBeenCalled(); expect(mocks.complete).not.toHaveBeenCalled()
  })
})
it('requires the complete frozen tool set and rejects duplicates, traversal or drift', async () => {
  const tools = await freezeAccountRootMigrationTools(root)
  await verifyAccountRootMigrationTools(root, tools)
  for (const invalid of [tools.slice(1), [...tools, tools[0]], [{ path: '../outside', sha256: 'x' }], tools.map((tool, i) => i ? tool : { ...tool, sha256: 'changed' })]) {
    await expect(verifyAccountRootMigrationTools(root, invalid)).rejects.toThrow('account_root_store_')
  }
})
