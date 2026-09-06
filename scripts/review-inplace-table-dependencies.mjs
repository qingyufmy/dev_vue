import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { loadMigrationPlan } from './lib/v4-migration-plan.mjs'
import { reviewTableDependencies } from './lib/inplace-table-dependencies.mjs'

const root = new URL('../', import.meta.url)
const source = JSON.parse(await readFile(new URL('docs/migration/dev-vue-inplace-source-20260906.json', root), 'utf8'))
const plan = await loadMigrationPlan({ rootDirectory: fileURLToPath(root) })
const report = reviewTableDependencies(plan, source)
const path = new URL('docs/migration/dev-vue-inplace-table-dependencies-20260906.json', root)
if (process.argv.length === 3 && process.argv[2] === '--verify') {
  if (JSON.stringify(JSON.parse(await readFile(path, 'utf8'))) !== JSON.stringify(report)) throw new Error('inplace_dependency_report_drift')
} else if (process.argv.length === 3 && process.argv[2] === '--write') {
  await writeFile(path, JSON.stringify(report, null, 2) + '\n')
} else throw new Error('inplace_dependency_arguments')
console.log(JSON.stringify(report.summary))
