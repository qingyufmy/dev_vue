import { readFile, open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
const base = new URL('./', import.meta.url)
const sha = value => createHash('sha256').update(value).digest('hex')
const check = (ok, code) => { if (!ok) throw Error(code) }
let c
try {
  check(process.platform === 'linux' && process.getuid() === 0, 'wallet_schema_probe_scope')
  const mysql = createRequire(import.meta.url)('/www/wwwroot/aurum-ai/node_modules/mysql2/promise.js')
  const credentials = JSON.parse(await readFile(`/proc/self/fd/${process.env.V4_BACKUP_CREDENTIAL_FD}`, 'utf8'))
  c = await mysql.createConnection({ ...credentials, database: 'dev_vue_m1_a', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true })
  const [[identity]] = await c.query('SELECT DATABASE() db,@@server_uuid uuid,VERSION() version')
  check(identity.db === 'dev_vue_m1_a' && identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'wallet_schema_probe_identity')
  const [[exists]] = await c.execute('SELECT COUNT(*) n FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?', ['payment_wallet_addresses'])
  check(!Number(exists.n), 'wallet_schema_probe_existing_table')
  const sql = await readFile(new URL('017_payment_wallet_addresses.sql', base), 'utf8')
  await c.query(sql)
  const [[definition]] = await c.query('SHOW CREATE TABLE payment_wallet_addresses')
  await c.beginTransaction()
  const run = 'ffffffff-ffff-4fff-8fff-ffffffffff20'
  await c.execute("INSERT INTO data_migration_runs (id,bindings_sha256,bindings_json,created_at_utc) VALUES (?,?,'{}',UTC_TIMESTAMP(3))", [run, 'a'.repeat(64)])
  const native = { id: 777970, chain: 'TRON', address_index: 0, address: 'T-synthetic-case-sensitive-fixture', created_at_utc: '2026-09-07 00:00:00.123',
    custody_reference: null, custody_evidence_sha256: null, custody_verified_at_utc: null, revision: '9007199254740993', origin: 'native',
    migration_run_id: null, source_sha256: null, imported_at_utc: null }
  const fields = Object.keys(native)
  const insert = row => c.execute(`INSERT INTO payment_wallet_addresses (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`, fields.map(key => row[key]))
  await insert(native)
  await insert({ ...native, id: 777971, address_index: 1, address: native.address.toLowerCase(), origin: 'legacy_import',
    created_at_utc: null, migration_run_id: run, source_sha256: 'b'.repeat(64), imported_at_utc: '2026-09-07 01:00:00.000' })
  await insert({ ...native, id: 777972, chain: 'ETH', custody_reference: 'fixture-provider/version-1', custody_evidence_sha256: 'c'.repeat(64), custody_verified_at_utc: '2026-09-07 01:00:00.000' })
  const cases = [
    ['negative_index', { address_index: -1 }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['unknown_chain', { chain: 'other' }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['empty_address', { address: '' }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['trailing_address_space', { address: 'address ' }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['trailing_chain_space', { chain: 'ETH ' }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['zero_revision', { revision: '0' }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['partial_custody', { custody_reference: 'fixture' }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['invalid_custody_hash', { custody_reference: 'fixture', custody_evidence_sha256: 'z'.repeat(64), custody_verified_at_utc: '2026-09-07 01:00:00.000' }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['native_missing_creation', { created_at_utc: null }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['native_import_binding', { migration_run_id: run }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['legacy_missing_binding', { origin: 'legacy_import' }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['unknown_origin', { origin: 'unknown' }, 'ER_CHECK_CONSTRAINT_VIOLATED'],
    ['duplicate_index', { address_index: 0 }, 'ER_DUP_ENTRY'],
    ['duplicate_address', { address: native.address }, 'ER_DUP_ENTRY'],
    ['missing_run', { origin: 'legacy_import', migration_run_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', source_sha256: 'd'.repeat(64), imported_at_utc: '2026-09-07 01:00:00.000' }, 'ER_NO_REFERENCED_ROW_2'],
  ]
  const rejectedCases = []
  for (const [name, changes, expected] of cases) {
    let code
    try { await insert({ ...native, id: 777973, address_index: 2, address: 'different-fixture', ...changes }) } catch (error) { code = error.code }
    check(code === expected, `wallet_schema_probe_${name}`); rejectedCases.push({ name, code })
  }
  const [rows] = await c.query('SELECT id,chain,address_index,address,created_at_utc,CAST(revision AS CHAR) revision,custody_reference FROM payment_wallet_addresses ORDER BY id')
  check(rows.length === 3 && rows[0].revision === '9007199254740993' && rows[0].created_at_utc === '2026-09-07 00:00:00.123'
    && rows[1].created_at_utc === null && rows[0].address !== rows[1].address && rows[0].address === rows[2].address, 'wallet_schema_probe_roundtrip')
  await c.rollback()
  const [[remaining]] = await c.query('SELECT COUNT(*) n FROM payment_wallet_addresses')
  const [[runs]] = await c.execute('SELECT COUNT(*) n FROM data_migration_runs WHERE id=?', [run])
  check(!Number(remaining.n) && !Number(runs.n), 'wallet_schema_probe_cleanup')
  const file = await open(new URL('receipt.json', base), 'wx', 0o600)
  try { await file.writeFile(JSON.stringify({ kind: 'wallet-address-schema-probe/v1', identity, sourceSqlSha256: sha(sql), ddl: definition['Create Table'],
    acceptedRows: 3, rejectedCases, stateRoundtrip: true, fixturesRolledBack: true, remainingRows: 0,
    addressValidityVerified: false, custodyVerified: false, currentDevVueWritten: false }, null, 2) + '\n'); await file.sync() } finally { await file.close() }
  console.log(JSON.stringify({ status: 'verified', accepted: 3, rejected: rejectedCases.length, remainingRows: 0 }))
} catch (error) {
  await c?.rollback().catch(() => {})
  console.error(JSON.stringify({ code: error.code ?? (/^wallet_schema_probe_/.test(error.message) ? error.message : 'wallet_schema_probe_failed') })); process.exitCode = 1
} finally { await c?.end() }
