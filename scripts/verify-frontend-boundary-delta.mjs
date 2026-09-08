import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { compareBoundaryDebt } from './lib/boundary-debt.mjs'

const project = fileURLToPath(new URL('../frontend/apps/www/', import.meta.url))
const require = createRequire(new URL('../frontend/apps/www/package.json', import.meta.url))
const manifestPath = require.resolve('nuxt/package.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const cli = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.nuxt
if (typeof cli !== 'string') throw new Error('nuxt_cli_not_found')
const prepare = spawnSync(process.execPath, [resolve(dirname(manifestPath), cli), 'prepare'], { cwd: project, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
if (prepare.error || prepare.status !== 0) throw new Error('nuxt_boundary_prepare_failed', { cause: prepare.error ?? prepare.stderr })
const inspection = spawnSync(process.execPath, [fileURLToPath(new URL('./inspect-frontend-boundaries.mjs', import.meta.url))], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
if (inspection.error || ![0, 1].includes(inspection.status)) throw new Error('frontend_boundary_inspection_failed', { cause: inspection.error ?? inspection.stderr })
const report = JSON.parse(inspection.stdout)
if (!Array.isArray(report.findings) || !Array.isArray(report.configErrors) || report.configErrors.length) throw new Error('frontend_boundary_config_invalid')
const baseline = JSON.parse(await readFile(new URL('../docs/architecture/frontend-boundary-debt.json', import.meta.url), 'utf8'))
const result = compareBoundaryDebt(report.findings, baseline, 'frontend')
console.log(JSON.stringify({ ...result, nuxtPreparation: 'completed before scan', limitation: 'Nuxt server implicit imports and dynamic component expressions still need coverage.' }, null, 2))
if (!result.passed) process.exitCode = 1
