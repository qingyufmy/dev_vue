import { readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { parse } from 'dotenv'
import mysql from 'mysql2/promise'
import { freezeAccountWave } from './lib/v4-account-wave-manifest.mjs'
import { readOriginalRows } from './lib/inplace-column-evidence.mjs'
import { readInplaceAccountTargetIdentity } from './lib/mysql-inplace-account-backfill.mjs'
import { canonical } from './lib/v4-backfill-contract.mjs'
const root = new URL('../', import.meta.url)
const json = async path => JSON.parse(await readFile(new URL(path, root), 'utf8'))
let connection
try {
  const mode = process.argv[2]
  if (process.argv.length !== 3 || !['--read-only', '--verify'].includes(mode)) throw Error('account_wave_arguments')
  const env = parse(await readFile(new URL('server/.env', root)))
  if (env.MYSQL_DATABASE !== 'dev_vue') throw Error('account_wave_database')
  const backup = await json('docs/migration/dev-vue-inplace-backup-20260906.json')
  const columnProof = await json('docs/migration/dev-vue-inplace-column-rehearsal-20260906.json')
  const review = await json('docs/migration/dev-vue-account-ownership-review-v2-20260906.json')
  const paths = ['scripts/freeze-dev-vue-account-wave.mjs', 'pnpm-lock.yaml',
    ...(await readdir(new URL('scripts/lib/', root))).filter(name => name.endsWith('.mjs')).map(name => `scripts/lib/${name}`),
    ...(await readdir(new URL('server/db/migrations/inplace/', root))).filter(name => name.endsWith('.sql')).map(name => `server/db/migrations/inplace/${name}`)]
  const tools = await Promise.all(paths.map(async path => ({ path, sha256: createHash('sha256').update(await readFile(new URL(path, root))).digest('hex') })))
  connection = await mysql.createConnection({ host: env.MYSQL_HOST, port: Number(env.MYSQL_PORT || 3306), user: env.MYSQL_USER,
    password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE, dateStrings: true, jsonStrings: true, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true })
  await connection.query("SET SESSION time_zone='+00:00'")
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY')
  const targetIdentity = await readInplaceAccountTargetIdentity(connection, { sourceEvidence: true })
  const originalRows = await readOriginalRows(connection, columnProof.originalColumns)
  const manifest = freezeAccountWave({ backup, columnProof, review, targetIdentity, originalRows, tools })
  await connection.rollback()
  const path = new URL('docs/migration/dev-vue-account-wave-draft-20260906.json', root)
  if (mode === '--verify') {
    if (canonical(JSON.parse(await readFile(path, 'utf8'))) !== canonical(manifest)) throw Error('account_wave_manifest_changed')
  } else await writeFile(path, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ status: 'draft_frozen', sourceRows: manifest.scope.sourceRows, manifestHash: manifest.manifestHash,
    executable: false, blockers: manifest.admission.blockers }))
} catch (error) {
  console.error(JSON.stringify({ code: /^(account_wave|inplace)_/.test(error.message) ? error.message : 'account_wave_freeze_failed' }))
  process.exitCode = 1
} finally { if (connection) await connection.end().catch(() => {}) }
