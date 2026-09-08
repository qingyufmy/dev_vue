import { describe, expect, it } from 'vitest'
import { inspectSqlWrite, inventorySource, summarizeWrites } from '../scripts/lib/sql-write-inventory.mjs'

describe('SQL source write evidence', () => {
  it('extracts single-table writes without mistaking values or upserts for additional writes', () => {
    expect(inspectSqlWrite("/* UPDATE wrong */ INSERT IGNORE INTO `a` (value) VALUES ('DELETE FROM b;') ON DUPLICATE KEY UPDATE value=VALUES(value)"))
      .toEqual({ operation: 'INSERT', table: 'a', review: null, dynamic: false })
    expect(inspectSqlWrite('UPDATE dev.a SET value=?').table).toBe('dev.a')
    expect(inspectSqlWrite('DELETE FROM a WHERE id=?').table).toBe('a')
    expect(inspectSqlWrite('REPLACE INTO a VALUES (?)').table).toBe('a')
    expect(inspectSqlWrite('SELECT id FROM a FOR UPDATE')).toBeNull()
  })

  it('keeps ambiguous or multi-table targets unresolved', () => {
    for (const sql of ['UPDATE a JOIN b ON a.id=b.id SET b.x=1', 'UPDATE a,b SET a.x=1', 'DELETE a FROM a JOIN b',
      'DELETE FROM a USING a JOIN b', 'INSERT INTO a', 'UPDATE a SET x=1; DELETE FROM b', 'WITH c AS (SELECT 1) UPDATE a SET x=1']) {
      expect(inspectSqlWrite(sql).table).toBeNull()
      expect(inspectSqlWrite(sql).review).toBeTruthy()
    }
  })

  it('does not resolve interpolated table names but keeps a static target with interpolated values', () => {
    const result = inventorySource('db.execute(`DELETE FROM ${table} WHERE id=?`); db.execute(`DELETE FROM known LIMIT ${limit}`)', 'server/src/modules/a/infra.ts')
    expect(result.writes).toMatchObject([
      { table: null, review: 'dynamic-or-incomplete-target', dynamic: true },
      { table: 'known', dynamic: true },
    ])
  })

  it('records indirect calls and literal builders without double-counting template segments', () => {
    const result = inventorySource('// INSERT INTO ignored\nconst sql = `UPDATE a SET x=${value}`; db.execute(sql); db.query(buildSql());', 'server/src/modules/a/infra.ts')
    expect(result.writes).toHaveLength(1)
    expect(result.writes[0]).toMatchObject({ table: 'a', writer: 'a', line: 2 })
    expect(result.indirectCalls).toHaveLength(2)
    expect(inventorySource('db.execute(`${sql} FOR SHARE`)', 'server/src/a.ts').indirectCalls).toHaveLength(1)
  })

  it('groups source writers without blessing them as owners', () => {
    const report = summarizeWrites(['a', 'b'].map(writer => inventorySource("db.execute('INSERT INTO outbox_events (id) VALUES (?)')", `server/src/modules/${writer}/repo.ts`)))
    expect(report.counts).toMatchObject({ tables: 1, writeCandidates: 2, multipleWriterTables: 1 })
    expect(report.tables[0].writers).toEqual(['a', 'b'])
    expect(report.tables[0].evidence).toHaveLength(2)
  })

  it('fails malformed TypeScript rather than publishing a partial inventory', () => {
    expect(() => inventorySource('const = ;', 'bad.ts')).toThrow()
  })
})
