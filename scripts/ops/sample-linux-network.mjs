import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

export const PROC_NET_DEV_PATH = '/proc/net/dev'
export const DEFAULT_NETWORK_INTERFACES = Object.freeze(['eth0', 'lo'])
export const DEFAULT_INTERVAL_MS = 1000

function normalizeInterfaces(value) {
  const values = Array.isArray(value) ? value : String(value || '').split(',')
  const interfaces = [...new Set(values.map(item => String(item).trim()).filter(Boolean))]
  if (interfaces.length === 0) throw new Error('at least one network interface is required')
  if (interfaces.length > 32) throw new Error('too many network interfaces')
  if (interfaces.some(name => !/^[A-Za-z0-9_.:-]{1,64}$/.test(name))) {
    throw new Error('network interface names contain unsupported characters')
  }
  return interfaces
}

function parsePositiveNumber(value, name, { integer = false, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0 || number > max || (integer && !Number.isInteger(number))) {
    throw new Error(`${name} must be a positive ${integer ? 'integer' : 'number'}`)
  }
  return number
}

function parseDuration(value) {
  const text = String(value || '').trim().toLowerCase()
  const match = text.match(/^([0-9]+(?:\.[0-9]+)?)(ms|s|m|h)?$/)
  if (!match) throw new Error(`invalid duration: ${value}`)
  const amount = Number(match[1])
  const multiplier = match[2] === 'ms' ? 1
    : match[2] === 'm' ? 60_000
      : match[2] === 'h' ? 3_600_000 : 1000
  return parsePositiveNumber(amount * multiplier, 'duration', { max: 365 * 24 * 60 * 60 * 1000 })
}

export function parseArguments(argv = []) {
  const options = {
    interfaces: [...DEFAULT_NETWORK_INTERFACES],
    intervalMs: DEFAULT_INTERVAL_MS,
    durationMs: null,
    jsonl: true,
    help: false,
  }
  const args = [...argv]
  const takeValue = (index, flag) => {
    const value = args[index + 1]
    if (value == null || value.startsWith('--')) throw new Error(`${flag} requires a value`)
    return value
  }

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index]
    if (flag === '--help' || flag === '-h') {
      options.help = true
      continue
    }
    if (flag === '--interfaces' || flag === '--interface') {
      options.interfaces = normalizeInterfaces(takeValue(index, flag))
      index += 1
      continue
    }
    if (flag === '--interval-ms') {
      options.intervalMs = parsePositiveNumber(takeValue(index, flag), 'interval-ms', {
        integer: true, max: 60_000,
      })
      index += 1
      continue
    }
    if (flag === '--interval') {
      options.intervalMs = parseDuration(takeValue(index, flag))
      if (options.intervalMs > 60_000) throw new Error('interval must not exceed 60 seconds')
      index += 1
      continue
    }
    if (flag === '--duration' || flag === '--duration-seconds') {
      options.durationMs = flag === '--duration-seconds'
        ? parsePositiveNumber(takeValue(index, flag), 'duration-seconds', {
          max: 365 * 24 * 60 * 60,
        }) * 1000
        : parseDuration(takeValue(index, flag))
      index += 1
      continue
    }
    if (flag === '--summary-only') {
      options.jsonl = false
      continue
    }
    if (flag === '--jsonl') {
      options.jsonl = true
      continue
    }
    throw new Error(`unknown option: ${flag}`)
  }

  return options
}

export function parseProcNetDev(content, interfaces = DEFAULT_NETWORK_INTERFACES) {
  const wanted = new Set(normalizeInterfaces(interfaces))
  const counters = Object.create(null)
  for (const line of String(content || '').split(/\r?\n/)) {
    const separator = line.indexOf(':')
    if (separator < 0) continue
    const name = line.slice(0, separator).trim()
    if (!wanted.has(name)) continue
    const fields = line.slice(separator + 1).trim().split(/\s+/)
    if (fields.length < 9) continue
    try {
      counters[name] = {
        rxBytes: BigInt(fields[0]),
        txBytes: BigInt(fields[8]),
      }
    } catch {
      // Ignore malformed rows; callers can report the interface as unavailable.
    }
  }
  return counters
}

function counterDelta(current, previous) {
  if (current == null || previous == null) return 0n
  if (current >= previous) return current - previous
  // A counter reset (for example after an interface restart) is a new sample,
  // not a negative transfer.
  return current
}

function jsonInteger(value) {
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : String(value)
}

function bigintValue(value) {
  try {
    if (typeof value === 'bigint') return value >= 0n ? value : 0n
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return BigInt(Math.floor(value))
    if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value)
  } catch {}
  return 0n
}

function sampleFromCounters(previous, current, interfaces, timestamp, intervalMs) {
  const sample = {
    type: 'sample',
    timestamp: new Date(timestamp).toISOString(),
    interval_ms: intervalMs,
    interfaces: Object.create(null),
    _deltas: Object.create(null),
  }
  for (const name of interfaces) {
    const before = previous[name]
    const after = current[name]
    const rx = counterDelta(after?.rxBytes, before?.rxBytes)
    const tx = counterDelta(after?.txBytes, before?.txBytes)
    sample.interfaces[name] = {
      available: Boolean(after),
      rx_bytes: jsonInteger(rx),
      tx_bytes: jsonInteger(tx),
      total_bytes: jsonInteger(rx + tx),
    }
    sample._deltas[name] = { rx, tx }
  }
  return sample
}

function percentile(values, quantile) {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1)
  return sorted[index]
}

export function summarizeNetworkSamples(samples, interfaces = DEFAULT_NETWORK_INTERFACES, {
  intervalMs = DEFAULT_INTERVAL_MS,
  startedAt = null,
  endedAt = null,
} = {}) {
  const names = normalizeInterfaces(interfaces)
  const aggregate = {}
  for (const name of names) {
    aggregate[name] = {
      samples: 0,
      totalRx: 0n,
      totalTx: 0n,
      rxValues: [],
      txValues: [],
    }
  }
  for (const sample of samples) {
    for (const name of names) {
      const delta = sample?._deltas?.[name] || {
        rx: bigintValue(sample?.interfaces?.[name]?.rx_bytes),
        tx: bigintValue(sample?.interfaces?.[name]?.tx_bytes),
      }
      if (!sample?._deltas?.[name] && !sample?.interfaces?.[name]) continue
      const row = aggregate[name]
      row.samples += 1
      row.totalRx += delta.rx
      row.totalTx += delta.tx
      row.rxValues.push(Number(delta.rx))
      row.txValues.push(Number(delta.tx))
    }
  }
  const result = {
    type: 'summary',
    interval_ms: intervalMs,
    sample_count: samples.length,
    ...(startedAt == null ? {} : { started_at: new Date(startedAt).toISOString() }),
    ...(endedAt == null ? {} : { ended_at: new Date(endedAt).toISOString() }),
    interfaces: Object.create(null),
  }
  for (const name of names) {
    const row = aggregate[name]
    const maxRx = row.rxValues.length ? Math.max(...row.rxValues) : 0
    const maxTx = row.txValues.length ? Math.max(...row.txValues) : 0
    result.interfaces[name] = {
      samples: row.samples,
      total_rx_bytes: jsonInteger(row.totalRx),
      total_tx_bytes: jsonInteger(row.totalTx),
      total_bytes: jsonInteger(row.totalRx + row.totalTx),
      max_rx_bytes: maxRx,
      max_tx_bytes: maxTx,
      p50_rx_bytes: percentile(row.rxValues, 0.50),
      p50_tx_bytes: percentile(row.txValues, 0.50),
      p95_rx_bytes: percentile(row.rxValues, 0.95),
      p95_tx_bytes: percentile(row.txValues, 0.95),
      p99_rx_bytes: percentile(row.rxValues, 0.99),
      p99_tx_bytes: percentile(row.txValues, 0.99),
    }
  }
  return result
}

async function readProcNetDev(path = PROC_NET_DEV_PATH, interfaces = DEFAULT_NETWORK_INTERFACES) {
  return parseProcNetDev(await readFile(path, 'utf8'), interfaces)
}

function emitJsonLine(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

export async function sampleNetwork({
  interfaces = DEFAULT_NETWORK_INTERFACES,
  intervalMs = DEFAULT_INTERVAL_MS,
  durationMs = null,
  jsonl = true,
  readCounters = readProcNetDev,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = () => Date.now(),
  emit = emitJsonLine,
  shouldStop = () => false,
} = {}) {
  const names = normalizeInterfaces(interfaces)
  const safeIntervalMs = parsePositiveNumber(intervalMs, 'interval-ms', {
    integer: true, max: 60_000,
  })
  const startedAt = now()
  const read = readCounters === readProcNetDev
    ? () => readProcNetDev(PROC_NET_DEV_PATH, names)
    : readCounters
  let previous = await read()
  const samples = []
  while (!shouldStop() && (durationMs == null || now() - startedAt < durationMs)) {
    await sleep(safeIntervalMs)
    if (shouldStop()) break
    const current = await read()
    const sample = sampleFromCounters(previous, current, names, now(), safeIntervalMs)
    previous = current
    samples.push(sample)
    if (jsonl) {
      const output = { ...sample }
      delete output._deltas
      emit(output)
    }
  }
  const summary = summarizeNetworkSamples(samples, names, {
    intervalMs: safeIntervalMs,
    startedAt,
    endedAt: now(),
  })
  emit(summary)
  return summary
}

export function usage() {
  return [
    'Usage: node scripts/ops/sample-linux-network.mjs [options]',
    '',
    'Options:',
    '  --interfaces eth0,lo       Interfaces to sample (default: eth0,lo)',
    '  --interval-ms 1000         Sampling interval in milliseconds',
    '  --interval 1s              Sampling interval (ms, s, m; max 60s)',
    '  --duration-seconds 900     Stop after the requested duration',
    '  --duration 15m             Stop after a duration with an optional unit',
    '  --summary-only             Emit only the final JSON summary',
    '  --jsonl                    Emit one JSON object per sample (default)',
    '  --help                     Show this help',
  ].join('\n')
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return
  }
  let stopped = false
  const stop = () => { stopped = true }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    await sampleNetwork({ ...options, shouldStop: () => stopped })
  } finally {
    process.removeListener('SIGINT', stop)
    process.removeListener('SIGTERM', stop)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(`[sample-linux-network] ${error.message}`)
    process.exitCode = 1
  })
}
