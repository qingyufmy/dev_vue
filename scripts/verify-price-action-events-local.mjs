import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { Script, createContext } from 'node:vm'
import { calculatePriceActionEvents } from '../server/dist-v4/modules/market/domain/price-action-events.js'

const [referencePath, destination] = process.argv.slice(2)
assert.ok(process.argv.length === 4 && isAbsolute(referencePath) && isAbsolute(destination))
const source = await readFile(referencePath, 'utf8')
const start = source.indexOf('export function buildTwoClosedBarBreakoutEvidence('), end = source.indexOf('\nconst _bridgeLocks', start)
assert.ok(start >= 0 && end > start)
const pure = source.slice(start, end).replace('export function', 'function')
assert.ok(!/\b(?:import|require|process|fetch)\b/.test(pure))
const context = createContext({ round5: value => Math.round(value * 100000) / 100000 })
new Script(`${pure}\nreference = buildTwoClosedBarBreakoutEvidence`).runInContext(context, { timeout: 1000 })
const scope = { sourceAccountId: '5', symbol: 'XAUUSD', timeframe: 'M5', timeframeMs: 300000 }
let seed = 913, checks = 0, breakouts = 0, reclaims = 0
const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296 }
for (let trial = 0; trial < 500; trial++) {
  const count = 29 + trial % 100
  let price = 1000
  const bars = Array.from({ length: count }, (_, index) => {
    const open = price
    price = Math.round((price + (random() - .48) * 12) * 100) / 100
    return { openTime: new Date(1700000000000 + index * 300000).toISOString(), open: String(open), close: String(price),
      high: String(Math.max(open, price) + 1), low: String(Math.min(open, price) - 1), closed: true }
  })
  const old = context.reference(bars.map(bar => ({ ...bar, time: bar.openTime, time_utc_msc: Date.parse(bar.openTime) })))
  const actual = calculatePriceActionEvents(bars, scope)
  // The bounded V4 window must keep exactly the same latest eight candidate semantics.
  assert.deepEqual(calculatePriceActionEvents(bars.slice(-30), scope), actual)
  let expectedCount = 0
  for (const direction of ['up', 'down']) {
    const expected = old.recent_confirmed[direction]
    const event = actual.find(item => item.kind === 'two_closed_bar_breakout' && item.direction === direction)
    assert.equal(Boolean(event), expected.found)
    if (!event) continue
    expectedCount++; breakouts++
    assert.equal(event.firstBarTime, expected.first_bar.time)
    assert.equal(event.confirmationBarTime, expected.second_bar.time)
    assert.equal(event.confirmationType, expected.confirmation_type)
    assert.equal(event.stillValid, expected.still_valid)
    assert.equal(event.invalidationBarTime, expected.invalidation_bar?.time ?? null)
    assert.equal(Math.round(Number(event.referencePrice) * 100000) / 100000, direction === 'up' ? expected.reference_high : expected.reference_low)
    const reclaim = actual.find(item => item.parentEventId === event.id)
    assert.equal(Boolean(reclaim), expected.reclaim.confirmed)
    if (!reclaim) continue
    expectedCount++; reclaims++
    assert.equal(reclaim.direction, expected.reclaim.recovery_direction)
    assert.equal(reclaim.firstBarTime, expected.reclaim.reclaim_bar.time)
    assert.equal(reclaim.confirmationBarTime, expected.reclaim.confirmation_bar.time)
    assert.equal(reclaim.confirmationType, expected.reclaim.confirmation_type)
    assert.equal(reclaim.stillValid, expected.reclaim.still_valid)
    assert.equal(reclaim.invalidationBarTime, expected.reclaim.invalidation_bar?.time ?? null)
    assert.equal(reclaim.reclaimCloseBeyondBreakoutBars, expected.reclaim.reclaim_close_beyond_breakout_bars)
    assert.equal(reclaim.confirmationCloseBeyondReclaimExtreme, expected.reclaim.confirmation_close_beyond_reclaim_extreme)
  }
  assert.equal(actual.length, expectedCount)
  checks++
}
assert.ok(breakouts > 0 && reclaims > 0)
const report = { kind: 'price-action-event-parity/v1', observedAt: new Date().toISOString(), passed: true,
  referencePath, referenceSha256: createHash('sha256').update(source).digest('hex'), checks, breakouts, reclaims,
  boundedWindowParity: true, databaseWrites: 0, modelCalls: 0, terminalCalls: 0,
  scope: 'Objective breakout/reclaim parity only; event usage ledger and independent-opportunity admission are not covered.' }
await writeFile(destination, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
console.log(JSON.stringify(report, null, 2))
