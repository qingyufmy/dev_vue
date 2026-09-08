import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyAccountProjectionReference } from '../scripts/lib/account-projection-reference-checks.mjs'

const reference = 'dev_vue_projection_reference_' + 'a'.repeat(24)
test('reference fixtures reject business database names before querying', async () => {
  let queried = false
  const connection = { query: async () => { queried = true } }
  for (const database of ['dev_vue', 'dev_vue_m1_source_20260907_02', reference + '`']) {
    await assert.rejects(verifyAccountProjectionReference(connection, database))
  }
  assert.equal(queried, false)
})

test('reference fixtures reject a connection still using the restored database', async () => {
  let began = false
  const connection = { query: async () => [[{ db: 'dev_vue_m1_source_20260907_02' }]],
    beginTransaction: async () => { began = true } }
  await assert.rejects(verifyAccountProjectionReference(connection, reference))
  assert.equal(began, false)
})

test('an unexpected fixture failure rolls back instead of committing partial data', async () => {
  const calls = []
  const connection = {
    query: async sql => {
      if (sql === 'SELECT DATABASE() db') return [[{ db: reference }]]
      calls.push(sql); throw Error('fixture_connection_failure')
    },
    beginTransaction: async () => { calls.push('begin') },
    rollback: async () => { calls.push('rollback') },
    commit: async () => { calls.push('commit') },
  }
  await assert.rejects(verifyAccountProjectionReference(connection, reference), /fixture_connection_failure/)
  assert.deepEqual(calls, ['begin', 'INSERT INTO users (id) VALUES (1)', 'rollback'])
})
