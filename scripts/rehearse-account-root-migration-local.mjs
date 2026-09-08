import assert from 'node:assert/strict'
import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import mysql from 'mysql2/promise'
import { hash } from './lib/v4-backfill-contract.mjs'
import { sha256 } from './lib/v4-migration-plan.mjs'
import { withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { readAccountBackfillV2Identity } from './lib/mysql-account-backfill-v2.mjs'
import { readAccountRootSnapshot, verifyAccountBusinessProjection } from './lib/mysql-account-root-snapshot.mjs'
import { loadAccountRootMigration, prepareAccountRootMigrationProof, coordinateAccountRootMigration } from './lib/inplace-account-root-migration.mjs'
import { freezeAccountRootMigrationTools, persistAccountRootMigrationProof, mysqlAccountRootMigrationStore } from './lib/mysql-account-root-migration.mjs'

const root = new URL('../', import.meta.url), target = 'dev_vue_m1_source_20260907_02'
let connection, output, phase = 'arguments'
try {
  const [mode, proofPath, destination] = process.argv.slice(2)
  assert.ok(['--prepare-restored-only', '--apply-restored-only', '--apply-lost-ddl-restored-only', '--read-only-restored'].includes(mode)
    && isAbsolute(proofPath) && isAbsolute(destination) && process.argv.length === 5 && proofPath !== destination)
  output = await open(destination, 'wx', 0o600)
  const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk)
  const credentials = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  assert.equal(credentials.host, '127.0.0.1'); assert.equal(credentials.user, 'root')
  assert.ok(Number.isInteger(credentials.port) && credentials.port > 1024 && credentials.port < 65536)
  connection = await mysql.createConnection({ host: credentials.host, port: credentials.port, user: credentials.user, password: credentials.password,
    database: target, dateStrings: true, jsonStrings: true, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false, connectTimeout: 5000 })
  await connection.query("SET SESSION time_zone='+00:00'")
  const [[identity]] = await connection.query('SELECT DATABASE() db,@@server_uuid uuid')
  assert.equal(identity.db, target); assert.equal(identity.uuid, 'ac423207-6ef3-11f1-b302-000c29fda104')
  const receipt = await withInplaceUpgradeLock(connection, target, async () => {
    const plan = await loadAccountRootMigration(root)
    if (mode === '--prepare-restored-only') {
      phase = 'prepare-preconditions'
      // This strict old-registry check rejects any existing started/completed
      // promotion record. A lost proof is never silently regenerated.
      const backfill = JSON.parse(await readFile(new URL('docs/architecture/account-wave-local-rehearsal-20260908-v3.json', root)))
      assert.equal(hash(backfill.frozen), backfill.manifestHash)
      assert.deepEqual(await readAccountBackfillV2Identity(connection), backfill.frozen.targetIdentity)
      for (const tool of backfill.frozen.tools) assert.equal(sha256(await readFile(new URL(tool.path, root))), tool.sha256)
      const snapshot = await readAccountRootSnapshot(connection)
      for (const expected of backfill.frozen.protectedBefore) {
        const actual = snapshot.tables.find(table => table.name === expected.name)
        assert.equal(actual.rows, expected.rows); assert.equal(actual.rowsSha256, expected.sha256)
      }
      const projection = JSON.parse(await readFile(new URL('docs/architecture/account-wave-projection-verification-20260908.json', root)))
      assert.equal(projection.rehearsalManifestHash, backfill.manifestHash)
      await verifyAccountBusinessProjection(connection, snapshot.metadata, projection)
      const proof = prepareAccountRootMigrationProof(plan, { database: target, serverUuid: identity.uuid }, snapshot.tables, await freezeAccountRootMigrationTools(root))
      await persistAccountRootMigrationProof(proofPath, proof)
    }
    phase = 'coordinate'
    const store = await mysqlAccountRootMigrationStore(connection, plan, root, proofPath)
    let result
    if (mode === '--apply-lost-ddl-restored-only') {
      let ddlCount = 0
      const execute = store.execute
      store.execute = async sql => { await execute(sql); ddlCount++; throw Error('injected_lost_ddl_response') }
      await assert.rejects(coordinateAccountRootMigration(store, plan, { apply: true }), /account_root_migration_ddl_unknown/)
      assert.equal(ddlCount, 1)
      result = { status: 'ddl-unknown-injected', ddlCount }
    } else result = await coordinateAccountRootMigration(store, plan, { apply: mode === '--apply-restored-only' })
    const proof = await store.proof()
    return { kind: 'account-root-registered-rehearsal/v1', observedAt: new Date().toISOString(), target, mode, result,
      registrySteps: plan.steps.length, priorRegistryHash: plan.priorRegistryHash, proofHash: proof.proofHash,
      currentDevVueWritten: false, scope: 'Fixed restored database; programs run locally. Registered promotion is retained with its journal, not undone by deleting history.' }
  })
  await output.writeFile(JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify(receipt))
} catch (error) {
  const code = /^account_root_(?:migration|store)_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'account_root_registered_rehearsal_failed'
  if (output) await output.writeFile(JSON.stringify({ failed: true, code, target, phase }) + '\n').catch(() => {})
  console.error(JSON.stringify({ code, phase })); process.exitCode = 1
} finally { if (connection) await connection.end().catch(() => {}); if (output) await output.close().catch(() => {}) }
