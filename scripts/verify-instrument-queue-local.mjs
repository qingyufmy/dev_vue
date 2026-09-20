import assert from 'node:assert/strict'
import { readFile, open } from 'node:fs/promises'
import { randomUUID, createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { developmentRedisConnection } from './lib/development-redis.mjs'
import { Queue, Worker, QueueEvents } from 'bullmq'
import { createBridgeInstrumentProcessor } from '../server/dist-v4/queue/bridge-instrument-processor.js'

const [destination] = process.argv.slice(2)
assert.ok(process.argv.length === 3 && isAbsolute(destination ?? ''))
const connection = await developmentRedisConnection()
const prefix = 'instrument-probe-' + randomUUID().replaceAll('-', '')
const name = 'readonly-instrument-test'
const output = await open(destination, 'wx', 0o600)
const report = { passed: false, scope: 'local_bullmq_worker_vm_redis_with_stub_business_port',
  redis: { host: connection.host, port: connection.port, db: connection.db }, checks: [], mysqlWrites: 0, terminalQueries: 0 }
const queue = new Queue(name, { connection, prefix })
const events = new QueueEvents(name, { connection, prefix })
let worker
try {
  await events.waitUntilReady()
  const calls = new Map()
  const processor = createBridgeInstrumentProcessor({ run: async requestId => {
    const count = (calls.get(requestId) ?? 0) + 1; calls.set(requestId, count)
    if (requestId === 'wait' && count === 1) return { state: 'retry', retryAt: new Date(Date.now() + 250).toISOString() }
    if (requestId === 'unknown' && count === 1) throw new Error('instrument_completion_unknown')
    return { state: 'terminal' }
  } })
  worker = new Worker(name, processor, { connection, prefix, concurrency: 1 })
  worker.on('error', () => {})
  await worker.waitUntilReady()
  const delayed = await queue.add('instrument.collection.collect', { requestId: 'wait' }, { attempts: 1 })
  assert.deepEqual(await delayed.waitUntilFinished(events, 10000), { state: 'terminal' })
  const first = await queue.getJob(delayed.id)
  assert.equal(calls.get('wait'), 2); assert.equal(first.attemptsMade, 1)
  report.checks.push('delayed_redelivery_succeeds_with_one_attempt_budget')
  const unknown = await queue.add('instrument.collection.collect', { requestId: 'unknown' }, { attempts: 2, backoff: { type: 'fixed', delay: 100 } })
  assert.deepEqual(await unknown.waitUntilFinished(events, 10000), { state: 'terminal' })
  const second = await queue.getJob(unknown.id)
  assert.equal(calls.get('unknown'), 2); assert.equal(second.attemptsMade, 2)
  report.checks.push('unknown_completion_uses_failure_retry_then_rereads_terminal_state')
  report.processorSha256 = createHash('sha256').update(await readFile(new URL('../server/dist-v4/queue/bridge-instrument-processor.js', import.meta.url))).digest('hex')
  report.passed = true
} catch (error) { report.errorCode = error?.code ?? error?.name ?? 'probe_failed'; process.exitCode = 1 }
finally {
  if (worker) await worker.close()
  await events.close()
  // Only this run's fresh queue namespace; never flush a shared Redis database.
  await queue.obliterate({ force: false }); await queue.close()
  report.queueRemoved = true; report.observedAt = new Date().toISOString()
  await output.writeFile(`${JSON.stringify(report, null, 2)}\n`); await output.close()
  console.log(JSON.stringify(report))
}
