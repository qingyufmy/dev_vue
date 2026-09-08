import { expect, it, vi } from 'vitest'
import { loadAccountRootMigration, prepareAccountRootMigrationProof, accountRootMigrationSnapshot, coordinateAccountRootMigration } from '../scripts/lib/inplace-account-root-migration.mjs'
import { accountRootRenames, accountRootRenameSql } from '../scripts/lib/account-root-promotion.mjs'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'
import { sha256 } from '../scripts/lib/v4-migration-plan.mjs'

const priorStep = { id: 'prior', checksum: hash('prior') }
const plan = { prior: { steps: [priorStep] }, priorRegistryHash: hash([priorStep]),
  step: { id: 'promotion', checksum: hash('promotion'), sql: accountRootRenameSql() } }
plan.steps = [...plan.prior.steps, plan.step]
const identity = { database: 'dev_vue', serverUuid: 'test-server' }
const journal = step => ({ id: step.id, checksum: step.checksum, status: 'completed',
  startedAt: '2026-09-08T00:00:00Z', completedAt: '2026-09-08T00:00:01Z' })
function fixture() {
  const before = ['database_upgrade_steps_v4', 'users', ...accountRootRenames.map(([name]) => name)].map(name => ({ name,
    ddl: `CREATE TABLE \`${name}\` (\n  \`id\` bigint NOT NULL\n) ENGINE=InnoDB AUTO_INCREMENT=10`, rows: 3, rowsSha256: hash(name) }))
  const names = new Map(accountRootRenames)
  const after = before.map(row => ({ ...row, name: names.get(row.name) ?? row.name,
    ddl: row.ddl.replace(/^CREATE TABLE `([^`]+)`/, (_full, name) => `CREATE TABLE \`${names.get(name) ?? name}\``) }))
  let actual = structuredClone(before), history = [journal(priorStep)]
  let proof = prepareAccountRootMigrationProof(plan, identity, before, [{ path: 'tool.mjs', sha256: hash('tool') }])
  const store = {
    history: vi.fn(async () => structuredClone(history)), proof: vi.fn(async () => structuredClone(proof)),
    identity: vi.fn(async () => identity), verifyTools: vi.fn(async () => {}),
    snapshot: vi.fn(async () => accountRootMigrationSnapshot(actual)), verifyPrior: vi.fn(async () => {}),
    begin: vi.fn(async step => { history.push({ ...journal(step), status: 'started', completedAt: null }) }),
    execute: vi.fn(async () => { actual = structuredClone(after) }),
    complete: vi.fn(async step => { history[history.length - 1] = journal(step) }),
  }
  return { store, before, after, get actual() { return actual }, set actual(value) { actual = value },
    get history() { return history }, set history(value) { history = value },
    get proof() { return proof }, set proof(value) { proof = value } }
}

it('appends exactly one step and retains the full previous registry', async () => {
  const actual = await loadAccountRootMigration(new URL('../', import.meta.url))
  expect(actual.steps).toHaveLength(148)
  expect(actual.steps.slice(0, 147)).toEqual(actual.prior.steps)
  expect(actual.step.sql).toBe(accountRootRenameSql())
  expect(actual.priorRegistryHash).toBe('6bd9b37a155323eeda3bc8e36cfb0e7f8beaf7743a6e92cbe3f9dc7e3040ef59')
})
it('checks pending state without any writes by default', async () => {
  const { store } = fixture()
  expect(await coordinateAccountRootMigration(store, plan)).toEqual({ status: 'pending', ddlCount: 0 })
  expect(store.begin).not.toHaveBeenCalled(); expect(store.execute).not.toHaveBeenCalled(); expect(store.complete).not.toHaveBeenCalled()
})
it('journals before one atomic DDL, verifies both sides and repeats without writes', async () => {
  const { store } = fixture()
  expect(await coordinateAccountRootMigration(store, plan, { apply: true })).toEqual({ status: 'applied', ddlCount: 1 })
  expect(store.begin.mock.invocationCallOrder[0]).toBeLessThan(store.execute.mock.invocationCallOrder[0])
  expect(store.execute.mock.invocationCallOrder[0]).toBeLessThan(store.complete.mock.invocationCallOrder[0])
  expect(store.verifyPrior.mock.calls.map(([state]) => state)).toEqual(['original', 'promoted'])
  expect(await coordinateAccountRootMigration(store, plan, { apply: true })).toEqual({ status: 'completed', ddlCount: 0 })
  expect(store.execute).toHaveBeenCalledOnce(); expect(store.begin).toHaveBeenCalledOnce(); expect(store.complete).toHaveBeenCalledOnce()
})
it('does not replay DDL when its response was lost after it took effect', async () => {
  const f = fixture(), execute = f.store.execute.getMockImplementation()
  f.store.execute.mockImplementationOnce(async () => { await execute(); throw Error('lost') })
  await expect(coordinateAccountRootMigration(f.store, plan, { apply: true })).rejects.toThrow('ddl_unknown')
  expect(f.store.complete).not.toHaveBeenCalled()
  expect(await coordinateAccountRootMigration(f.store, plan)).toEqual({ status: 'reconcile', ddlCount: 0 })
  expect(await coordinateAccountRootMigration(f.store, plan, { apply: true })).toEqual({ status: 'reconciled', ddlCount: 0 })
  expect(f.store.execute).toHaveBeenCalledOnce()
})
it('requires fresh inspection before retrying a DDL which did not take effect', async () => {
  const f = fixture()
  f.store.execute.mockRejectedValueOnce(Error('connection failed'))
  await expect(coordinateAccountRootMigration(f.store, plan, { apply: true })).rejects.toThrow('ddl_unknown')
  expect(await coordinateAccountRootMigration(f.store, plan, { apply: true })).toEqual({ status: 'applied', ddlCount: 1 })
  expect(f.store.begin).toHaveBeenCalledOnce()
})
it('reconciles from persisted state in a newly constructed store with no in-memory execution flags', async () => {
  const first = fixture(), execute = first.store.execute.getMockImplementation()
  first.store.execute.mockImplementationOnce(async () => { await execute(); throw Error('lost') })
  await expect(coordinateAccountRootMigration(first.store, plan, { apply: true })).rejects.toThrow('ddl_unknown')
  const second = fixture()
  second.actual = structuredClone(first.actual); second.history = structuredClone(first.history); second.proof = structuredClone(first.proof)
  expect(await coordinateAccountRootMigration(second.store, plan, { apply: true })).toEqual({ status: 'reconciled', ddlCount: 0 })
  expect(second.store.begin).not.toHaveBeenCalled(); expect(second.store.execute).not.toHaveBeenCalled()
  expect(second.store.complete).toHaveBeenCalledOnce()
})
it('recovers an uncertain started journal write without duplicating it', async () => {
  const f = fixture(), begin = f.store.begin.getMockImplementation()
  f.store.begin.mockImplementationOnce(async step => { await begin(step); throw Error('lost') })
  await expect(coordinateAccountRootMigration(f.store, plan, { apply: true })).rejects.toThrow('begin_unknown')
  expect(f.store.execute).not.toHaveBeenCalled()
  expect(await coordinateAccountRootMigration(f.store, plan, { apply: true })).toEqual({ status: 'applied', ddlCount: 1 })
  expect(f.store.begin).toHaveBeenCalledOnce()
})
it('recovers a completed journal response without rewriting completion', async () => {
  const f = fixture(), complete = f.store.complete.getMockImplementation()
  f.store.complete.mockImplementationOnce(async step => { await complete(step); throw Error('lost') })
  await expect(coordinateAccountRootMigration(f.store, plan, { apply: true })).rejects.toThrow('complete_unknown')
  expect(await coordinateAccountRootMigration(f.store, plan, { apply: true })).toEqual({ status: 'completed', ddlCount: 0 })
  expect(f.store.complete).toHaveBeenCalledOnce(); expect(f.store.execute).toHaveBeenCalledOnce()
})
it('reconciles when completion failed before persistence', async () => {
  const f = fixture()
  f.store.complete.mockRejectedValueOnce(Error('connection lost'))
  await expect(coordinateAccountRootMigration(f.store, plan, { apply: true })).rejects.toThrow('complete_unknown')
  expect(await coordinateAccountRootMigration(f.store, plan, { apply: true })).toEqual({ status: 'reconciled', ddlCount: 0 })
  expect(f.store.execute).toHaveBeenCalledOnce()
})
it('rejects unrecorded promotion, completed-but-old layout and partial changes', async () => {
  for (const type of ['unrecorded', 'completed-old', 'partial']) {
    const f = fixture()
    if (type === 'unrecorded') f.actual = f.after
    if (type === 'completed-old') f.history.push(journal(plan.step))
    if (type === 'partial') f.actual[0].ddl += ' unexpected'
    await expect(coordinateAccountRootMigration(f.store, plan, { apply: true })).rejects.toThrow()
    expect(f.store.begin).not.toHaveBeenCalled(); expect(f.store.execute).not.toHaveBeenCalled()
  }
})
it('rejects unknown, tampered and incomplete prior history before touching evidence', async () => {
  for (const type of ['unknown', 'checksum', 'missing']) {
    const f = fixture()
    if (type === 'unknown') f.history.push(journal({ id: 'unknown', checksum: 'x' }))
    if (type === 'checksum') f.history[0].checksum = 'changed'
    if (type === 'missing') f.history = []
    await expect(coordinateAccountRootMigration(f.store, plan, { apply: true })).rejects.toThrow()
    expect(f.store.proof).not.toHaveBeenCalled(); expect(f.store.begin).not.toHaveBeenCalled()
  }
})
it('rejects a proof for another database or step, corrupted bytes and tool drift', async () => {
  for (const type of ['identity', 'stepChecksum', 'corrupt', 'tools']) {
    const f = fixture()
    if (type === 'identity') f.proof.identity = { ...identity, database: 'elsewhere' }
    if (type === 'stepChecksum') f.proof.stepChecksum = 'changed'
    if (type === 'corrupt') f.proof.proofHash = 'changed'
    if (type === 'tools') f.store.verifyTools.mockRejectedValue(Error('tool_drift'))
    if (['identity', 'stepChecksum'].includes(type)) { const { proofHash, ...body } = f.proof; f.proof.proofHash = hash(body) }
    await expect(coordinateAccountRootMigration(f.store, plan, { apply: true })).rejects.toThrow()
    expect(f.store.begin).not.toHaveBeenCalled()
  }
})
it('ignores only journal row contents, retaining journal schema and independent history validation', async () => {
  const f = fixture()
  f.actual[0].rows++; f.actual[0].rowsSha256 = hash('started')
  expect(await coordinateAccountRootMigration(f.store, plan)).toEqual({ status: 'pending', ddlCount: 0 })
  f.actual[0].ddl = f.actual[0].ddl.replace('bigint', 'int')
  await expect(coordinateAccountRootMigration(f.store, plan)).rejects.toThrow('state_conflict')
})
it('predicts table and FK renames without rewriting column names or quoted text', () => {
  const f = fixture(), source = f.before.find(row => row.name === 'users')
  source.ddl = "CREATE TABLE `users` (\n  `trading_accounts` varchar(50) DEFAULT 'trading_accounts',\n  CONSTRAINT `trading_accounts` FOREIGN KEY (`trading_accounts`) REFERENCES `trading_accounts` (`id`)\n) ENGINE=InnoDB"
  const expected = source.ddl.replace('REFERENCES `trading_accounts`', 'REFERENCES `trading_accounts_legacy_v3`')
  const actual = accountRootMigrationSnapshot(f.before, true).find(row => row.name === 'users')
  expect(actual.ddlSha256).toBe(sha256(expected))
})
it('rejects business writes until the migration is completed', async () => {
  const f = fixture()
  f.history.push({ ...journal(plan.step), status: 'started', completedAt: null })
  f.actual = structuredClone(f.after); f.actual.find(row => row.name === 'users').rows++
  await expect(coordinateAccountRootMigration(f.store, plan, { apply: true })).rejects.toThrow('state_conflict')
  expect(f.store.complete).not.toHaveBeenCalled()
})
it('permits normal business rows and auto-increment growth after completion but protects old source data and structure', async () => {
  const f = fixture()
  await coordinateAccountRootMigration(f.store, plan, { apply: true })
  const account = f.actual.find(row => row.name === 'trading_accounts')
  account.rows++; account.rowsSha256 = hash('new account'); account.ddl = account.ddl.replace('AUTO_INCREMENT=10', 'AUTO_INCREMENT=11')
  expect(await coordinateAccountRootMigration(f.store, plan)).toEqual({ status: 'completed', ddlCount: 0 })
  account.ddl = account.ddl.replace('bigint', 'int')
  await expect(coordinateAccountRootMigration(f.store, plan)).rejects.toThrow('completed_state_conflict')
  account.ddl = account.ddl.replace('int NOT', 'bigint NOT')
  f.actual.find(row => row.name === 'trading_accounts_legacy_v3').rowsSha256 = hash('source changed')
  await expect(coordinateAccountRootMigration(f.store, plan)).rejects.toThrow('completed_state_conflict')
})
it('rechecks data after started persistence and refuses post-DDL drift or failed historical checks', async () => {
  const f = fixture(), begin = f.store.begin.getMockImplementation()
  f.store.begin.mockImplementationOnce(async step => { await begin(step); f.actual[1].rows++ })
  await expect(coordinateAccountRootMigration(f.store, plan, { apply: true })).rejects.toThrow('precondition_changed')
  expect(f.store.execute).not.toHaveBeenCalled()
  const g = fixture(), execute = g.store.execute.getMockImplementation()
  g.store.execute.mockImplementationOnce(async () => { await execute(); g.actual[1].rows++ })
  await expect(coordinateAccountRootMigration(g.store, plan, { apply: true })).rejects.toThrow('postcondition_failed')
  expect(g.store.complete).not.toHaveBeenCalled()
  const h = fixture()
  h.store.verifyPrior.mockRejectedValue(Error('historical_conflict'))
  await expect(coordinateAccountRootMigration(h.store, plan, { apply: true })).rejects.toThrow('historical_conflict')
  expect(h.store.begin).not.toHaveBeenCalled()
})
