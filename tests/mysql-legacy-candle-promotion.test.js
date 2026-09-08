import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { hash } from '../scripts/lib/v4-backfill-contract.mjs'
import { legacyCandlePromotionSnapshot, legacyCandleRenameSql } from '../scripts/lib/legacy-candle-promotion.mjs'

const mock = vi.hoisted(() => ({ prior: null, backfill: null, receipt: null, begin: vi.fn(), complete: vi.fn() }))
vi.mock('node:fs/promises', async original => {
  const fs = await original()
  return { ...fs, readFile: async (path, ...args) => {
    if (String(path).endsWith('/legacy-candle-backfill-plan-20260908.json') && mock.backfill) return JSON.stringify(mock.backfill)
    if (String(path).endsWith('/legacy-candle-backfill-repeat-20260908.json') && mock.receipt) return JSON.stringify(mock.receipt)
    return fs.readFile(path, ...args)
  } }
})
vi.mock('../scripts/lib/mysql-legacy-candle-build-migration.mjs', () => ({
  mysqlLegacyCandleBuildMigrationStore: async () => mock.prior,
  freezeLegacyCandleBuildTools: async () => [{ path: 'prior', sha256: hash('prior') }],
}))
vi.mock('../scripts/lib/mysql-inplace-column-store.mjs', () => ({ mysqlColumnStore: () => ({ begin: mock.begin, complete: mock.complete }) }))
import { freezeLegacyCandlePromotionTools, prepareVerifiedCandlePromotionProof, verifyCandleBackfillEvidence, mysqlLegacyCandlePromotionStore } from '../scripts/lib/mysql-legacy-candle-promotion.mjs'

const root = new URL('../', import.meta.url), dirs = []
afterEach(async () => { vi.clearAllMocks(); mock.backfill = null; mock.receipt = null; await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true }))) })
async function fixture() {
  const identity = { database: 'restore', serverUuid: 'uuid' }, names = ['legacy_candle_backfill_v4', 'legacy_candle_mappings_v4', 'market_candles_build_v4']
  const tables = ['database_upgrade_steps_v4', 'users', 'market_data_sources', 'market_candles', ...names].map(name => ({ name,
    ddl: `CREATE TABLE \`${name}\` (\n  \`id\` bigint NOT NULL\n) ENGINE=InnoDB`, rows: 1, rowsSha256: hash(name) }))
  const snapshot = legacyCandlePromotionSnapshot(tables)
  const body = { kind: 'legacy-candle-backfill-proof/v1', identity: { databaseName: identity.database, serverUuid: identity.serverUuid }, conversionPlanHash: hash('conversion'),
    protectedSnapshotHash: hash(snapshot.filter(row => !names.includes(row.name))), historyHash: hash('history') }
  const backfill = { ...body, proofHash: hash(body) }
  const receipt = { kind: 'legacy-candle-backfill-rehearsal/v1', identity: body.identity, proofHash: backfill.proofHash, conversionPlanHash: body.conversionPlanHash,
    result: { status: 'verified', batches: 0, planHash: body.conversionPlanHash, mappedRows: 1, projectionRows: 1 }, committedBatches: 0,
    inputRows: 1, outputRows: 1, protectedSnapshotHash: body.protectedSnapshotHash, historyHash: body.historyHash,
    buildTables: snapshot.filter(row => names.includes(row.name)).map(({ name, rows, rowsSha256, schemaSha256 }) => ({ name, rows, rowsSha256, schemaSha256 })) }
  mock.backfill = backfill; mock.receipt = receipt
  const plan = { prior: { additions: names.map(table => ({ table })) }, priorRegistryHash: hash('registry'), step: { id: 'promotion', checksum: hash('promotion'), sql: legacyCandleRenameSql() } }
  const tools = await freezeLegacyCandlePromotionTools(root)
  const proof = prepareVerifiedCandlePromotionProof(plan, identity, tables, backfill, receipt, body.historyHash, tools)
  const directory = await mkdtemp(join(tmpdir(), 'candle-promotion-test-')); dirs.push(directory)
  const paths = Object.fromEntries(['proof', 'build', 'projection', 'observer', 'terminal', 'account'].map(name => [name, join(directory, name + '.json')]))
  await writeFile(paths.proof, JSON.stringify(proof)); await writeFile(paths.build, JSON.stringify({ definitions: [] }))
  const rootStore = { identity: vi.fn(async () => identity), history: vi.fn(async () => []) }
  mock.prior = { priorStore: { priorStore: { priorStore: { rootStore } } } }
  const connection = { query: vi.fn() }
  return { identity, plan, proof, backfill, receipt, tables, tools, rootStore, connection,
    open: () => mysqlLegacyCandlePromotionStore(connection, plan, root, paths) }
}

it('prepares promotion only from independently verified full backfill rows and source snapshot', async () => {
  const f = await fixture()
  expect(f.proof.before).toHaveLength(7); expect(f.proof.after).toHaveLength(7)
  f.tables.find(row => row.name === 'market_candles_build_v4').rows++
  expect(() => prepareVerifiedCandlePromotionProof(f.plan, f.identity, f.tables, f.backfill, f.receipt, f.receipt.historyHash, f.tools)).toThrow('backfill_data_changed')
  f.tables.find(row => row.name === 'market_candles_build_v4').rows--
  f.tables.find(row => row.name === 'users').rows++
  expect(() => prepareVerifiedCandlePromotionProof(f.plan, f.identity, f.tables, f.backfill, f.receipt, f.receipt.historyHash, f.tools)).toThrow('source_changed')
})
it('rejects source database, incomplete receipt, mismatched plan and changed historical logs', async () => {
  const f = await fixture()
  expect(() => verifyCandleBackfillEvidence(f.backfill, f.receipt, { ...f.identity, database: 'other' })).toThrow('backfill_identity')
  expect(() => verifyCandleBackfillEvidence(f.backfill, { ...f.receipt, result: { ...f.receipt.result, status: 'filling' } }, f.identity)).toThrow('backfill_receipt')
  expect(() => verifyCandleBackfillEvidence(f.backfill, { ...f.receipt, conversionPlanHash: hash('other') }, f.identity)).toThrow('backfill_receipt')
  expect(() => prepareVerifiedCandlePromotionProof(f.plan, f.identity, f.tables, f.backfill, f.receipt, hash('other'), f.tools)).toThrow('history_changed')
})
it('checks identity and exact action before journal writes or rename', async () => {
  const f = await fixture(), store = await f.open()
  await expect(store.execute('DROP TABLE users')).rejects.toThrow('_sql')
  await expect(store.begin({ ...f.plan.step, checksum: hash('other') })).rejects.toThrow('_step')
  for (const action of ['begin', 'execute', 'complete']) {
    f.rootStore.identity.mockRejectedValueOnce(Error('lock_lost'))
    await expect(store[action](action === 'execute' ? f.plan.step.sql : f.plan.step)).rejects.toThrow('lock_lost')
  }
  expect(f.connection.query).not.toHaveBeenCalled(); expect(mock.begin).not.toHaveBeenCalled(); expect(mock.complete).not.toHaveBeenCalled()
  await store.begin(f.plan.step); await store.execute(f.plan.step.sql); await store.complete(f.plan.step)
  expect(f.connection.query).toHaveBeenCalledExactlyOnceWith(f.plan.step.sql)
})
