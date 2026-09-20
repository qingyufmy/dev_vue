import { readFile, writeFile } from 'node:fs/promises'
import { loadRiskStructureSource } from './lib/risk-structure-source.mjs'

const mode = process.argv[2]
if (process.argv.length !== 3 || !['--write', '--check'].includes(mode)) throw Error('risk_structure_mode_invalid')
const root = new URL('../', import.meta.url)
const plan = await loadRiskStructureSource(root)
const sql = '-- Risk structure only. Apply through the reviewed append-only coordinator, never directly.\n'
  + '-- No default policy, control seed, legacy backfill, or trading activation.\n'
  + '-- Sources and immutable hashes: scripts/lib/risk-structure-source.mjs.\n\n'
  + plan.statements.map(row => row.sql + ';').join('\n\n') + '\n'
const target = new URL('server/db/migrations/inplace/043_risk_core_structures.sql', root)
if (mode === '--write') await writeFile(target, sql, { encoding: 'utf8', flag: 'wx' })
else if (await readFile(target, 'utf8') !== sql) throw Error('risk_structure_generated_drift')
console.log(JSON.stringify({ passed: true, mode, statements: plan.statements.length, sqlSha256: plan.sqlSha256,
  scope: 'Source generation check only. This command does not execute SQL or verify database upgrade readiness.' }))
