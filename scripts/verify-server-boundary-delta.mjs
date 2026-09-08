import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { compareBoundaryDebt } from './lib/boundary-debt.mjs'

const result = spawnSync(process.execPath, [fileURLToPath(new URL('./inspect-server-boundaries.mjs', import.meta.url))], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
if (result.error || ![0, 1].includes(result.status)) throw new Error('server_boundary_inspection_failed', { cause: result.error ?? result.stderr })
const report = JSON.parse(result.stdout)
if (!Array.isArray(report.findings)) throw new Error('invalid_server_boundary_report')
const baseline = JSON.parse(await readFile(new URL('../docs/architecture/server-boundary-debt.json', import.meta.url), 'utf8'))
const delta = compareBoundaryDebt(report.findings, baseline)
console.log(JSON.stringify(delta, null, 2))
if (!delta.passed) process.exitCode = 1
