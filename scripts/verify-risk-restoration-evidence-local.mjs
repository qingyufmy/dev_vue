import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { loadRiskStructureMigration } from './lib/inplace-risk-structure.mjs'
import { prepareRiskRestorationEvidence } from './lib/risk-restoration-evidence.mjs'

const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination ?? ''))
const root = new URL('../', import.meta.url)
const base = 'D:/dev_codex/.backup-risk-20260909-01/'
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const doc = name => new URL('docs/architecture/' + name + '.json', root)
const report = prepareRiskRestorationEvidence(await loadRiskStructureMigration(root), {
  baseline: await json(doc('risk-restored-baseline-166-20260909')),
  reference: await json(doc('risk-structure-reference-rehearsal-20260909')),
  reports: await Promise.all(['create-loss', 'alter-loss', 'complete', 'replay']
    .map(name => json(doc('risk-rehearsal-' + name + '-20260909')))),
  receiptBytes: await readFile(base + 'receipt.json'),
  publicReceipt: await json(doc('risk-local-backup-verified-20260909')),
  source: await json(base + 'source-snapshot.json'),
  restored: await json(base + 'restored-snapshot.json'),
  priorProof: await json(doc('current-context-changes-proof-20260908')),
})
await writeFile(destination, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({ passed: true, kind: report.kind, stepsCompleted: report.stepsCompleted,
  tableCount: report.parity.tableCount, sourceWrites: report.sourceWrites, currentDatabaseUpgraded: false }))
