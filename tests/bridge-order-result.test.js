import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function classify(retcode, order = 0, deal = 0) {
  const script = `
import json, sys
from types import SimpleNamespace
sys.path.insert(0, r'${path.join(root, 'public', 'ai').replaceAll('\\', '\\\\')}')
from bridge_order_result import classify_deal_result
mt5 = SimpleNamespace(TRADE_RETCODE_DONE=10009, TRADE_RETCODE_DONE_PARTIAL=10010)
result = SimpleNamespace(retcode=${retcode}, order=${order}, deal=${deal})
print(json.dumps(classify_deal_result(result, mt5)))
`
  const run = spawnSync('python', ['-c', script], { cwd: root, encoding: 'utf8' })
  expect(run.stderr).toBe('')
  expect(run.status).toBe(0)
  return JSON.parse(run.stdout.trim())
}

function runBridgeHelper(expression) {
  const script = `
import json, sys
from types import SimpleNamespace
sys.path.insert(0, r'${path.join(root, 'public', 'ai').replaceAll('\\', '\\\\')}')
from bridge_order_result import parse_required_order_volume, retryable_trade_retcodes
mt5 = SimpleNamespace(
    TRADE_RETCODE_REQUOTE=10004,
    TRADE_RETCODE_REJECT=10006,
    TRADE_RETCODE_PRICE_CHANGED=10020,
    TRADE_RETCODE_PRICE_OFF=10021,
    TRADE_RETCODE_TOO_MANY_REQUESTS=10024,
)
print(json.dumps(${expression}))
`
  const run = spawnSync('python', ['-c', script], { cwd: root, encoding: 'utf8' })
  expect(run.stderr).toBe('')
  expect(run.status).toBe(0)
  return JSON.parse(run.stdout.trim())
}

describe('MT5 deal result classification', () => {
  it('accepts only an explicit DONE result as fully successful', () => {
    expect(classify(10009, 123, 456)).toBe('success')
  })

  it('keeps partial fills out of the success path', () => {
    expect(classify(10010, 123, 456)).toBe('partial')
  })

  it('treats a non-DONE ticket as uncertain rather than successful', () => {
    expect(classify(10008, 123, 0)).toBe('uncertain')
    expect(classify(10004, 0, 456)).toBe('uncertain')
  })

  it('keeps deterministic no-ticket failures rejected', () => {
    expect(classify(10015, 0, 0)).toBe('rejected')
  })
})

describe('MT5 execution input safety', () => {
  it('retries only official quote-refresh outcomes', () => {
    const retcodes = runBridgeHelper('sorted(retryable_trade_retcodes(mt5))')
    expect(retcodes).toEqual([10004, 10020, 10021])
    expect(retcodes).not.toContain(10006)
    expect(retcodes).not.toContain(10024)
  })

  it('requires an explicit numeric order volume', () => {
    expect(runBridgeHelper('parse_required_order_volume({})')).toEqual([null, 'volume is required'])
    expect(runBridgeHelper('parse_required_order_volume({"volume": True})')).toEqual([null, 'volume must be numeric'])
    expect(runBridgeHelper('parse_required_order_volume({"volume": "0.02"})')).toEqual([0.02, null])
    expect(runBridgeHelper('parse_required_order_volume({"lot": "0.03", "volume": "0.02"})')).toEqual([0.03, null])
  })
})
