import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { listWalletAddresses } from '../server/dist-v4/modules/commerce/infrastructure/mysql-wallet-address-reader.js'
import { writePrivateJson } from './lib/v4-backup-io.mjs'
const root = new URL('../', import.meta.url)
const check = (ok, code) => { if (!ok) throw new Error(code) }
let c
try {
  check(process.platform === 'linux' && process.getuid() === 0, 'wallet_reader_probe_scope')
  const manifest = JSON.parse(await readFile(new URL('../tools.json', root), 'utf8'))
  for (const file of manifest) {
    check(/^[a-zA-Z0-9_./-]+$/.test(file.path) && !file.path.split('/').includes('..'), 'wallet_reader_probe_path')
    check(createHash('sha256').update(await readFile(new URL(file.path, root))).digest('hex') === file.sha256, 'wallet_reader_probe_file')
  }
  const mysql = createRequire(import.meta.url)('/www/wwwroot/aurum-ai/node_modules/mysql2/promise.js')
  const credentials = JSON.parse(await readFile(`/proc/self/fd/${process.env.V4_BACKUP_CREDENTIAL_FD}`, 'utf8'))
  c = await mysql.createConnection({ ...credentials, database: 'dev_vue_m1_a', dateStrings: true, timezone: 'Z' })
  const [[identity]] = await c.query('SELECT DATABASE() db,@@server_uuid uuid,VERSION() version')
  check(identity.db === 'dev_vue_m1_a' && identity.uuid === 'ac423207-6ef3-11f1-b302-000c29fda104', 'wallet_reader_probe_identity')
  const counts = async () => { const [[row]] = await c.query('SELECT COUNT(*) n FROM payment_wallet_addresses'); return String(row.n) }
  check(await counts() === '0', 'wallet_reader_probe_reference_not_empty')
  await c.query("SET SESSION time_zone='+00:00'")
  await c.beginTransaction()
  check((await listWalletAddresses(c, { chain: 'TRON' })).items.length === 0, 'wallet_reader_probe_empty')
  await c.execute("INSERT INTO payment_wallet_addresses (id,chain,address_index,address,created_at_utc,revision,origin) VALUES (777981,'TRON',9,'synthetic-reader-one','2026-09-07 01:00:00.123','9007199254740993','native')")
  await c.execute("INSERT INTO payment_wallet_addresses (id,chain,address_index,address,created_at_utc,revision,origin,custody_reference,custody_evidence_sha256,custody_verified_at_utc) VALUES (777999,'TRON',100,'synthetic-reader-two','2026-09-07 01:00:00.123','1','native','synthetic-vault',?,'2026-09-07 02:00:00.456')", ['a'.repeat(64)])
  const first = await listWalletAddresses(c, { chain: 'TRON', afterId: '777980', limit: 1 })
  check(first.items.length === 1 && first.nextAfterId === '777981' && first.items[0].addressIndex === '9'
    && first.items[0].createdAtUtc === '2026-09-07T01:00:00.123Z' && first.items[0].revision === '9007199254740993'
    && first.items[0].custody.status === 'unverified', 'wallet_reader_probe_first_page')
  const second = await listWalletAddresses(c, { chain: 'TRON', afterId: first.nextAfterId, limit: 1 })
  check(second.items.length === 1 && second.nextAfterId === null && second.items[0].id === '777999'
    && second.items[0].addressIndex === '100' && second.items[0].custody.status === 'verified'
    && second.items[0].custody.verifiedAtUtc === '2026-09-07T02:00:00.456Z', 'wallet_reader_probe_second_page')
  check((await listWalletAddresses(c, { chain: 'ETH' })).items.length === 0, 'wallet_reader_probe_chain')
  await c.rollback()
  const finalCount = await counts()
  check(finalCount === '0', 'wallet_reader_probe_rollback')
  await writePrivateJson(new URL('../receipt.json', root).pathname, { kind: 'wallet-reader-probe/v1', identity, toolManifest: manifest,
    fixtureOnly: true, exactRevisionAndMilliseconds: true, sparseIndicesAndIds: true, chainScopeVerified: true,
    custodyStatesVerified: true, actualCustodyControlVerified: false, rolledBack: true, finalCount, currentDevVueWritten: false, consumersSwitched: false })
  console.log(JSON.stringify({ status: 'verified', exactRevisionAndMilliseconds: true, sparsePagination: true, rolledBack: true }))
} catch (error) {
  await c?.rollback().catch(() => {})
  console.error(JSON.stringify({ code: /^wallet_reader_probe_[a-z_]+$/.test(error.message) ? error.message : error.code ?? 'wallet_reader_probe_failed' })); process.exitCode = 1
} finally { await c?.end() }
