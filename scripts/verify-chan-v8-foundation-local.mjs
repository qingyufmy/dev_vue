import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, isAbsolute } from 'node:path'
import { Script, createContext } from 'node:vm'
import { normalizeBarsForChan, detectFractals } from '../server/dist-v4/modules/market/domain/chan-v8/bars.js'
import { buildBis } from '../server/dist-v4/modules/market/domain/chan-v8/bis.js'
import { calculateMacdSeries, roundMacdEvidence } from '../server/dist-v4/modules/market/domain/chan-v8/macd.js'

const [referencePath, destination] = process.argv.slice(2)
assert.ok(process.argv.length === 4 && isAbsolute(referencePath) && isAbsolute(destination))
const source = await readFile(referencePath, 'utf8')
const start = source.indexOf('function roundMacdEvidence(')
const end = source.indexOf('function inspectActivePivotLifecycle(')
assert.ok(start > 0 && end > start)
// Evaluate only the pure function range: no imports, DB, Bridge, process or I/O.
const segment = source.slice(start, end)
assert.ok(!/\b(?:import|require|process|fetch)\b/.test(segment))
const context = createContext({})
new Script(`const MIN_BARS_PER_BI=5; const DEBUG_CHAN=false; ${segment}
globalThis.reference={normalizeBarsForChan,detectFractals,buildBis,calculateMacdSeries,roundMacdEvidence}`)
  .runInContext(context, { timeout: 1000 })
const reference = context.reference
const canonical = value => JSON.parse(JSON.stringify(value))
const sha = value => createHash('sha256').update(value).digest('hex')
let random = 92741
const next = () => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random / 4294967296 }
let checked = 0, nonemptyBis = 0, inclusionCases = 0
for (let trial = 0; trial < 120; trial++) {
  const count = [0, 1, 2, 30, 150, 1000, 1800, 2000][trial % 8]
  const rates = Array.from({ length: count }, (_, index) => {
    const close = 2000 + 15 * Math.sin(index / (3 + trial % 9)) + next()
    const range = 1 + next() * (trial % 3 === 0 ? 20 : 2)
    return { open: close - 0.2, close, high: close + range, low: close - range, time: 1700000000 + index * 300 }
  })
  if (trial % 7 === 0 && count > 10) rates[7].high = NaN
  const before = canonical(rates)
  const oldBars = reference.normalizeBarsForChan(rates), bars = normalizeBarsForChan(rates)
  assert.deepEqual(canonical(bars), canonical(oldBars))
  const oldFractals = reference.detectFractals(oldBars), fractals = detectFractals(bars)
  assert.deepEqual(canonical(fractals), canonical(oldFractals))
  const bis = buildBis(fractals, bars)
  assert.deepEqual(canonical(bis), canonical(reference.buildBis(oldFractals, oldBars)))
  const closes = rates.map(row => row.close)
  assert.deepEqual(canonical(calculateMacdSeries(closes)), canonical(reference.calculateMacdSeries(closes)))
  assert.deepEqual(canonical(rates), before)
  if (bis.bis.length) nonemptyBis++
  if (bars.length < count) inclusionCases++
  checked += 4
}
assert.ok(nonemptyBis > 0 && inclusionCases > 0)
for (const value of [0, -0, NaN, Infinity, -Infinity, 1e-15, -0.123456789, '1.234567890']) {
  assert.equal(roundMacdEvidence(value), reference.roundMacdEvidence(value)); checked++
}
const targetFiles = ['types', 'bars', 'bis', 'macd'].map(name => `server/src/modules/market/domain/chan-v8/${name}.ts`)
const targetHashes = []
for (const path of targetFiles) targetHashes.push({ path, sha256: sha(await readFile(resolve(path))) })
const report = { kind: 'chan-v8-foundation-parity/v1', passed: true, checked, trials: 120,
  nonemptyBis, inclusionCases, referenceSha256: sha(source), referencePureRangeSha256: sha(segment), targetHashes,
  scope: 'pure MACD, inclusion, fractals and strokes only; not segments, centers, divergence, full v8 or Worker integration',
  databaseWrites: 0, observedAt: new Date().toISOString() }
await writeFile(destination, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify(report))
