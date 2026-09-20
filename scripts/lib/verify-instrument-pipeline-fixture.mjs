import assert from 'node:assert/strict'
import { developmentRedisConnection } from './development-redis.mjs'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import { Queue, Worker, QueueEvents } from 'bullmq'
import { createMysqlInstrumentCollectionRequester } from '../../server/dist-v4/modules/trading/infrastructure/mysql-instrument-collection-requester.js'
import { createMysqlInstrumentCollectionTasks } from '../../server/dist-v4/modules/trading/infrastructure/mysql-instrument-collection-tasks.js'
import { createMysqlInstrumentSnapshotReader } from '../../server/dist-v4/modules/trading/infrastructure/mysql-instrument-snapshot-reader.js'
import { writeInstrumentProjection } from '../../server/dist-v4/modules/trading/infrastructure/mysql-trading-repository.js'
import { BridgeInstrumentCollector } from '../../server/dist-v4/modules/bridge/application/bridge-instrument-collector.js'
import { BridgeInstrumentWorker } from '../../server/dist-v4/modules/bridge/application/bridge-instrument-worker.js'
import { createBridgeInstrumentProcessor } from '../../server/dist-v4/queue/bridge-instrument-processor.js'
import { BullMqOutboxTaskPublisher } from '../../server/dist-v4/outbox/infrastructure/bullmq-outbox-task-publisher.js'
import { MysqlOutboxRepository } from '../../server/dist-v4/outbox/infrastructure/mysql-outbox-repository.js'
import { OutboxDispatcher } from '../../server/dist-v4/outbox/application/outbox-dispatcher.js'
import { BridgeGatewayQueryTransport } from '../../server/dist-v4/modules/bridge/application/bridge-gateway-query-transport.js'
import { InProcessBridgeGatewayDirectory } from '../../server/dist-v4/modules/bridge/application/bridge-gateway-directory.js'

/** Requires the caller's already-created connection-local fixture tables, never a normal business connection. */
export async function verifyInstrumentPipelineFixture(connection, borrowed, input) {
  await connection.query(`ALTER TABLE instrument_collection_requests_v4 ADD request_bucket BIGINT DEFAULT 0,
    ADD attempts INT DEFAULT 0,ADD error_code VARCHAR(128),ADD result_revision BIGINT,
    ADD requested_at_utc DATETIME(3),ADD updated_at_utc DATETIME(3),ADD completed_at_utc DATETIME(3),ADD revision BIGINT DEFAULT 1,
    ADD UNIQUE KEY request_scope(user_id,trading_account_id,symbol,request_bucket)`)
  await connection.query(`CREATE TEMPORARY TABLE outbox_events (id BIGINT AUTO_INCREMENT PRIMARY KEY,event_id VARCHAR(36) UNIQUE,aggregate_type VARCHAR(64),
    aggregate_id VARCHAR(36),event_type VARCHAR(128),payload_json JSON,status VARCHAR(16),attempts INT,
    available_at_utc DATETIME(3),created_at_utc DATETIME(3),lease_owner VARCHAR(128),lease_expires_at_utc DATETIME(3),dispatched_at_utc DATETIME(3)) ENGINE=InnoDB`)
  await connection.query('UPDATE bridge_connection_sessions SET last_seen_at_utc=UTC_TIMESTAMP(3)')
  const executor = { ...borrowed, execute: connection.execute.bind(connection) }
  const requester = createMysqlInstrumentCollectionRequester(executor)
  const scope = { userId: input.route.userId, accountId: input.route.accountId, symbol: input.symbol }
  const request = await requester.request(scope)
  assert.equal(request.created, true)
  assert.deepEqual(await requester.request(scope), { requestId: request.requestId, created: false })
  const [[event]] = await connection.query('SELECT event_id,event_type,payload_json FROM outbox_events')
  const payload = typeof event.payload_json === 'string' ? JSON.parse(event.payload_json) : event.payload_json
  assert.deepEqual(payload, { request_id: request.requestId })
  const redis = await developmentRedisConnection()
  const prefix = 'instrument-pipeline-' + randomUUID().replaceAll('-', ''), name = 'instrument-fixture'
  const queue = new Queue(name, { connection: redis, prefix }), events = new QueueEvents(name, { connection: redis, prefix })
  let worker, socketServer, terminal, serverSocket, transport, transportError, queries = 0
  try {
    await events.waitUntilReady()
    const route = { ...input.route, platform: 'mt5', sessionId: 'session-1', timezoneOffsetMinutes: 180 }
    const reader = createMysqlInstrumentSnapshotReader(connection)
    const before = await reader.readRevision(scope.accountId, scope.symbol)
    const directory = new InProcessBridgeGatewayDirectory()
    transport = new BridgeGatewayQueryTransport({ current: async () => route }, directory, { isAuthorized: async () => true })
    socketServer = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(socketServer, 'listening')
    const connected = once(socketServer, 'connection')
    terminal = new WebSocket(`ws://127.0.0.1:${socketServer.address().port}`)
    ;[serverSocket] = await connected
    await once(terminal, 'open')
    directory.attach(route, { send: message => new Promise((resolve, reject) => serverSocket.send(JSON.stringify(message), error => error ? reject(error) : resolve())),
      close: () => serverSocket.close() })
    serverSocket.on('message', data => {
      try { transport.receive(route, JSON.parse(data.toString())) }
      catch (error) { transportError = error; transport.cancelConnection(route.connectionId) }
    })
    terminal.on('message', data => {
      try {
        const request = JSON.parse(data.toString())
        assert.equal(request.type, 'query.request'); assert.equal(request.payload.resource, 'market.instrument')
        assert.equal(request.payload.params.symbol, scope.symbol)
        queries++
        terminal.send(JSON.stringify({ v: 4, type: 'query.response', message_id: `response:${randomUUID()}`,
          correlation_id: request.message_id, sent_at_utc_msc: Date.now(), route: request.route,
          payload: { request_id: request.payload.request_id, resource: 'market.instrument', observed_at_utc_msc: Date.now(),
            source_revision: 'fixture-query-1', source: 'terminal', items: [input.raw], has_more: false, next_cursor: null } }))
      } catch (error) { transportError = error; transport.cancelConnection(route.connectionId) }
    })
    const collector = new BridgeInstrumentCollector(transport, reader, { write: value => writeInstrumentProjection(executor, value) })
    const processor = new BridgeInstrumentWorker(createMysqlInstrumentCollectionTasks(executor), { current: async () => route }, collector)
    worker = new Worker(name, createBridgeInstrumentProcessor(processor), { connection: redis, prefix, concurrency: 1, autorun: false })
    worker.on('error', () => {})
    await worker.waitUntilReady()
    const publisher = new BullMqOutboxTaskPublisher({ bridgeInstrument: queue })
    const repository = new MysqlOutboxRepository(executor)
    const waitForDueBatch = async dispatcher => {
      const deadline = Date.now() + 10000
      let result
      do {
        result = await dispatcher.runBatch(10)
        if (result.claimed > 0) return result
        await delay(50)
      } while (Date.now() < deadline)
      return result
    }
    const failedDispatch = new OutboxDispatcher(repository, { publish: async () => { throw new Error('fixture_queue_unavailable') } })
    const failedBatch = await waitForDueBatch(failedDispatch)
    if (failedBatch.claimed !== 1) {
      const [[clock]] = await connection.query('SELECT UTC_TIMESTAMP(3) databaseNow,available_at_utc availableAt,status FROM outbox_events')
      const error = new Error('pipeline_outbox_not_due')
      error.clockEvidence = { ...clock, applicationNow: new Date().toISOString() }
      throw error
    }
    assert.deepEqual(failedBatch, { claimed: 1, dispatched: 0, failed: 1 })
    const [[retry]] = await connection.query('SELECT status,attempts,lease_owner FROM outbox_events')
    assert.equal(retry.status, 'pending'); assert.equal(Number(retry.attempts), 1); assert.equal(retry.lease_owner, null)
    const dispatcher = new OutboxDispatcher(repository, publisher)
    assert.deepEqual(await waitForDueBatch(dispatcher), { claimed: 1, dispatched: 1, failed: 0 })
    // Do not overlap transactions on the single connection owning temporary tables.
    void worker.run()
    const job = await queue.getJob(event.event_id)
    assert.deepEqual(await job.waitUntilFinished(events, 10000), { state: 'collected', revision: before + 1 })
    const [[completed]] = await connection.execute('SELECT status,result_revision FROM instrument_collection_requests_v4 WHERE id=?', [request.requestId])
    assert.equal(completed.status, 'succeeded'); assert.equal(Number(completed.result_revision), before + 1)
    assert.equal((await reader.read(scope.accountId, scope.symbol)).revision, before + 1)
    // A distinct delivery of the same durable request must not collect or increment facts again.
    const replay = await queue.add('instrument.collection.collect', { requestId: request.requestId })
    assert.deepEqual(await replay.waitUntilFinished(events, 10000), { state: 'terminal' })
    assert.equal(queries, 1); assert.equal(await reader.readRevision(scope.accountId, scope.symbol), before + 1)
    assert.equal(transportError, undefined); assert.equal(transport.inflight(), 0)
    assert.deepEqual(await dispatcher.runBatch(10), { claimed: 0, dispatched: 0, failed: 0 })
    const [[dispatched]] = await connection.query('SELECT status,attempts,lease_owner,dispatched_at_utc FROM outbox_events')
    assert.equal(dispatched.status, 'dispatched'); assert.equal(Number(dispatched.attempts), 2)
    assert.equal(dispatched.lease_owner, null); assert.ok(dispatched.dispatched_at_utc)
  } finally {
    if (worker) await worker.close()
    transport?.cancelConnection(input.route.connectionId)
    terminal?.terminate(); serverSocket?.terminate()
    if (socketServer) await new Promise(resolve => socketServer.close(resolve))
    await events.close(); await queue.obliterate({ force: false }); await queue.close()
  }
  return 'request_dispatcher_real_queue_loopback_websocket_transport_write_completion_and_replay'
}
