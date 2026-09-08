import { open, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import mysql from 'mysql2/promise'
import { hash } from './lib/v4-backfill-contract.mjs'
import { readAccountBackfillV2Identity } from './lib/mysql-account-backfill-v2.mjs'
import { withInplaceUpgradeLock } from './lib/mysql-inplace-column-store.mjs'
import { readAccountRootSnapshot, verifyAccountBusinessProjection } from './lib/mysql-account-root-snapshot.mjs'
import { compactRootSnapshot, executeAccountRootPromotion, promotionFingerprint } from './lib/account-root-promotion.mjs'

const root = new URL('../', import.meta.url), target = 'dev_vue_m1_source_20260907_02'
const sha = value => createHash('sha256').update(value).digest('hex')
let connection, output, phase = 'arguments'
try {
  const [mode, destination, planPath] = process.argv.slice(2)
  const restore = mode === '--restore-restored-only'
  assert.ok((restore || mode === '--promote-restored-only') && isAbsolute(destination)
    && process.argv.length === (restore ? 5 : 4) && (!restore || isAbsolute(planPath)))
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
    let plan
    if (restore) {
      phase = 'load-recovery-proof'
      plan = JSON.parse(await readFile(planPath))
      assert.equal(plan.target, target); assert.equal(plan.kind, 'account-root-promotion-proof/v1')
      const { planHash, ...body } = plan; assert.equal(hash(body), planHash)
      for (const tool of plan.tools) assert.equal(sha(await readFile(new URL(tool.path, root))), tool.sha256)
    } else {
      phase = 'preconditions'
      const backfill = JSON.parse(await readFile(new URL('docs/architecture/account-wave-local-rehearsal-20260908-v3.json', root)))
      assert.equal(hash(backfill.frozen), backfill.manifestHash)
      assert.deepEqual(await readAccountBackfillV2Identity(connection), backfill.frozen.targetIdentity)
      for (const tool of backfill.frozen.tools) assert.equal(sha(await readFile(new URL(tool.path, root))), tool.sha256)
      const snapshot = await readAccountRootSnapshot(connection)
      for (const row of backfill.frozen.protectedBefore) {
        const actual = snapshot.tables.find(table => table.name === row.name)
        assert.equal(actual.rows, row.rows); assert.equal(actual.rowsSha256, row.sha256)
      }
      const projection = JSON.parse(await readFile(new URL('docs/architecture/account-wave-projection-verification-20260908.json', root)))
      assert.equal(projection.rehearsalManifestHash, backfill.manifestHash)
      await verifyAccountBusinessProjection(connection, snapshot.metadata, projection)
      const paths = ['scripts/rehearse-account-root-promotion-local.mjs', 'scripts/lib/account-root-promotion.mjs', 'scripts/lib/mysql-account-root-snapshot.mjs']
      const tools = [...backfill.frozen.tools, ...await Promise.all(paths.map(async path => ({ path, sha256: sha(await readFile(new URL(path, root))) })))]
      const body = { kind: 'account-root-promotion-proof/v1', target, before: compactRootSnapshot(snapshot.tables), after: compactRootSnapshot(snapshot.tables, true), tools }
      plan = { ...body, planHash: hash(body) }
      const persisted = await open(destination + '.plan.json', 'wx', 0o600)
      try { await persisted.writeFile(JSON.stringify(plan, null, 2) + '\n'); await persisted.sync() } finally { await persisted.close() }
    }
    let ddlCount = 0
    const store = { snapshot: async () => compactRootSnapshot((await readAccountRootSnapshot(connection)).tables),
      rename: async sql => { await connection.query(sql); ddlCount++; if (!restore) throw Error('injected_lost_ddl_response') } }
    phase = restore ? 'restore' : 'promote'
    const proof = restore ? { before: plan.after, after: plan.before } : plan
    if (!restore) await assert.rejects(executeAccountRootPromotion(store, proof, { apply: true }), /outcome_unknown/)
    const result = await executeAccountRootPromotion(store, proof, { apply: true, restore })
    if (restore) {
      assert.ok(['applied', 'already-applied'].includes(result.status))
      assert.equal(ddlCount, result.status === 'applied' ? 1 : 0)
    } else { assert.equal(result.status, 'already-applied'); assert.equal(ddlCount, 1) }
    phase = 'verify'
    const [references] = await connection.query("SELECT REFERENCED_TABLE_NAME parent FROM information_schema.KEY_COLUMN_USAGE WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME='strategy_subscriptions' AND CONSTRAINT_NAME='fk_strategy_subscriptions_account'")
    assert.deepEqual(references.map(row => row.parent), [restore ? 'trading_accounts' : 'trading_accounts_legacy_v3'])
    if (restore) await readAccountBackfillV2Identity(connection)
    return { kind: 'account-root-promotion-rehearsal/v1', observedAt: new Date().toISOString(), target,
      mode: restore ? 'restored' : 'promoted', planHash: plan.planHash, ddlCount, finalFingerprint: promotionFingerprint(proof.after),
      tables: proof.after.length, legacySubscriptionParent: references[0].parent, lostResponseReconciled: !restore, currentDevVueWritten: false,
      scope: 'Restored-database experiment, not registered current dev_vue migration; restore requires all original row and DDL fingerprints unchanged.' }
  })
  await output.writeFile(JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify(receipt))
} catch (error) {
  const code = /^[a-zA-Z][a-zA-Z0-9_]+$/.test(error?.code ?? '') ? error.code
    : /^account_promotion_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'account_root_promotion_rehearsal_failed'
  if (output) await output.writeFile(JSON.stringify({ failed: true, code, target, phase }) + '\n').catch(() => {})
  console.error(JSON.stringify({ code, phase })); process.exitCode = 1
} finally { if (connection) await connection.end().catch(() => {}); if (output) await output.close().catch(() => {}) }
