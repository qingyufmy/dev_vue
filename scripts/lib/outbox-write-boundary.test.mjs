import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inspectOutboxSource } from './outbox-write-boundary.mjs'

const producer = 'server/src/modules/risk/infrastructure/repository.ts'
const dispatcher = 'server/src/outbox/infrastructure/repository.ts'
const scan = (sql, file = producer) => inspectOutboxSource(`const sql = ${JSON.stringify(sql)}`, file)
test('permits producer inserts and dispatcher updates but rejects reversed roles', () => {
  const insert = 'INSERT INTO outbox_events (event_id) VALUES (?)'
  const update = 'UPDATE outbox_events SET status=? WHERE event_id=?'
  assert.equal(scan(insert).length, 0)
  assert.equal(scan(update, dispatcher).length, 0)
  assert.equal(scan(update).length, 1)
  assert.equal(scan(insert, dispatcher).length, 1)
  assert.equal(scan(insert, 'server/src/modules/risk/transport/routes.ts').length, 1)
})
test('rejects replacement, upsert, deletion, DDL and ambiguous targets', () => {
  for (const sql of [
    'INSERT INTO outbox_events (event_id) VALUES (?) ON DUPLICATE KEY UPDATE status=?',
    'REPLACE INTO outbox_events (event_id) VALUES (?)', 'DELETE FROM outbox_events',
    'TRUNCATE TABLE outbox_events', 'UPDATE outbox_events e JOIN users u ON u.id=e.id SET e.status=?',
  ]) assert.equal(scan(sql).length, 1, sql)
})
test('ignores quoted values and comments, and checks template statements', () => {
  assert.equal(scan("INSERT INTO outbox_events (event_type) VALUES ('UPDATE') /* REPLACE */").length, 0)
  assert.equal(inspectOutboxSource('const sql = `INSERT INTO outbox_events (event_id) VALUES ${values}`', producer).length, 0)
  assert.equal(inspectOutboxSource('const sql = `UPDATE outbox_events SET status=${value}`', producer).length, 1)
})
