import test from 'node:test'
import assert from 'node:assert/strict'
import { readRiskStructureTable } from '../scripts/lib/mysql-risk-structure-state.mjs'
import { tableDefinitionHash } from '../scripts/lib/inplace-foundation-upgrade.mjs'

const table = 'risk_policy_sets_v4'
const ddl = 'CREATE TABLE `risk_policy_sets_v4` (\n  `id` bigint unsigned NOT NULL AUTO_INCREMENT,\n  PRIMARY KEY (`id`)\n) ENGINE=InnoDB AUTO_INCREMENT=8 DEFAULT CHARSET=utf8mb4'
function fixture({ objects = [{ kind: 'BASE TABLE', engine: 'InnoDB' }], triggers = [], definition = ddl, count = '0' } = {}) {
  const calls = []
  return { calls,
    async execute(sql, params) { calls.push({ sql, params }); return [sql.includes('information_schema.TABLES') ? objects : triggers] },
    async query(sql) { calls.push({ sql }); return [sql.startsWith('SHOW') ? [{ 'Create Table': definition }] : [{ n: count }]] },
  }
}
test('reports missing tables without issuing SHOW or reading payloads', async () => {
  const connection = fixture({ objects: [] })
  assert.equal(await readRiskStructureTable(connection, table), null)
  assert.equal(connection.calls.length, 1)
})
test('reads canonical schema and exact count without treating AUTO_INCREMENT data counter as a schema change', async () => {
  const connection = fixture({ count: '7' })
  const state = await readRiskStructureTable(connection, table)
  assert.equal(state.rows, 7)
  assert.equal(state.hash, tableDefinitionHash(ddl.replace('AUTO_INCREMENT=8', 'AUTO_INCREMENT=19')))
  assert.notEqual(state.hash, tableDefinitionHash(ddl.replace('bigint unsigned', 'bigint')))
  assert.equal(connection.calls.length, 4)
})
test('rejects dynamic identifiers before issuing a query', async () => {
  const connection = fixture()
  await assert.rejects(readRiskStructureTable(connection, 'users'), /outside_scope/)
  await assert.rejects(readRiskStructureTable(connection, 'risk_policy_sets_v4`;DROP TABLE users'), /outside_scope/)
  assert.equal(connection.calls.length, 0)
})
test('rejects views, non-InnoDB tables, unexpected triggers and mismatched SHOW results', async () => {
  for (const options of [{ objects: [{ kind: 'VIEW', engine: null }] }, { objects: [{ kind: 'BASE TABLE', engine: 'MyISAM' }] },
    { triggers: [{ name: 'unexpected' }] }, { definition: ddl.replace('risk_policy_sets_v4', 'other') }]) {
    await assert.rejects(readRiskStructureTable(fixture(options), table), /risk_structure_/)
  }
})
test('rejects lossy or malformed row counts', async () => {
  for (const count of ['9007199254740993', '-1', '1.5', null, '']) {
    await assert.rejects(readRiskStructureTable(fixture({ count }), table), /row_count_invalid/)
  }
})
