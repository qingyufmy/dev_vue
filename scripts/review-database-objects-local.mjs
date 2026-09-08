import { readFile, open } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { sha256 } from './lib/v4-migration-plan.mjs'

const [mode, host, destination] = process.argv.slice(2)
if (mode !== '--read-only' || process.argv.length !== 5 || !/^[a-zA-Z0-9_.-]+$/.test(host) || !isAbsolute(destination)) throw Error('object_review_arguments')
const output = await open(destination, 'wx', 0o600)
try {
  const source = await readFile(new URL('review-database-objects-host.py', import.meta.url), 'utf8')
  const result = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, '/usr/bin/python3 -B -'], { input: source, encoding: 'utf8', timeout: 60000, windowsHide: true })
  if (result.status !== 0) throw Error('object_review_ssh_failed')
  const report = JSON.parse(result.stdout.trim())
  if (report.kind !== 'database-privileged-object-review/v1' || report.database !== 'dev_vue' || report.server_uuid !== 'ac423207-6ef3-11f1-b302-000c29fda104'
    || report.database_writes !== 0 || report.privilege_changes !== 0 || !report.two_reads_equal || !report.privileged_metadata) throw Error('object_review_response')
  report.sourceSha256 = sha256(source)
  await output.writeFile(JSON.stringify(report, null, 2) + '\n'); await output.sync()
  console.log(JSON.stringify(Object.fromEntries(Object.entries(report.objects).map(([key, value]) => [key, value.length]))))
} finally { await output.close() }
