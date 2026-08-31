import { describe, expect, it } from 'vitest'
import {
  parseArguments,
  parseProcNetDev,
  sampleNetwork,
  summarizeNetworkSamples,
} from '../../scripts/ops/sample-linux-network.mjs'

const PROC_FIXTURE = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
  eth0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0
    lo: 3000 30 0 0 0 0 0 0 3000 30 0 0 0 0 0 0
`

describe('Linux network sampler', () => {
  it('parses only the requested interfaces and preserves 64-bit counters', () => {
    expect(parseProcNetDev(PROC_FIXTURE, ['eth0'])).toEqual({
      eth0: { rxBytes: 1000n, txBytes: 2000n },
    })
    expect(parseProcNetDev(PROC_FIXTURE, ['missing'])).toEqual({})
  })

  it('summarizes interface totals and percentiles without mixing loopback into eth0', () => {
    const summary = summarizeNetworkSamples([
      { _deltas: { eth0: { rx: 10n, tx: 20n }, lo: { rx: 100n, tx: 100n } } },
      { _deltas: { eth0: { rx: 30n, tx: 40n }, lo: { rx: 200n, tx: 200n } } },
    ], ['eth0', 'lo'], { intervalMs: 1000 })

    expect(summary.interfaces.eth0).toMatchObject({
      total_rx_bytes: 40,
      total_tx_bytes: 60,
      max_rx_bytes: 30,
      max_tx_bytes: 40,
      p50_tx_bytes: 20,
      p95_tx_bytes: 40,
    })
    expect(summary.interfaces.lo).toMatchObject({
      total_rx_bytes: 300,
      total_tx_bytes: 300,
    })
  })

  it('samples injected counters and emits a final summary deterministically', async () => {
    const counters = [
      { eth0: { rxBytes: 100n, txBytes: 200n }, lo: { rxBytes: 50n, txBytes: 50n } },
      { eth0: { rxBytes: 110n, txBytes: 230n }, lo: { rxBytes: 70n, txBytes: 70n } },
      { eth0: { rxBytes: 125n, txBytes: 260n }, lo: { rxBytes: 90n, txBytes: 90n } },
    ]
    const emitted = []
    let clock = 0
    const summary = await sampleNetwork({
      interfaces: ['eth0', 'lo'],
      intervalMs: 1000,
      durationMs: 2000,
      readCounters: async () => counters.shift(),
      sleep: async ms => { clock += ms },
      now: () => clock,
      emit: value => emitted.push(value),
    })

    expect(summary.sample_count).toBe(2)
    expect(summary.interfaces.eth0.total_tx_bytes).toBe(60)
    expect(summary.interfaces.lo.total_rx_bytes).toBe(40)
    expect(emitted).toHaveLength(3)
    expect(emitted.at(-1)).toBe(summary)
  })

  it('validates command-line durations and interface names', () => {
    expect(parseArguments(['--interfaces', 'eth0,lo', '--interval', '250ms', '--duration', '15m']))
      .toMatchObject({ interfaces: ['eth0', 'lo'], intervalMs: 250, durationMs: 900_000 })
    expect(() => parseArguments(['--interfaces', '../secret'])).toThrow('unsupported characters')
    expect(() => parseArguments(['--interval-ms', '0'])).toThrow('positive integer')
  })
})
