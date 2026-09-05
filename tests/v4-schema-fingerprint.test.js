import { describe, expect, it } from 'vitest'
import { readSchemaFingerprint, schemaFingerprint } from '../scripts/lib/v4-schema-fingerprint.mjs'

const schema = { charset_name: 'utf8mb4', collation_name: 'utf8mb4_unicode_ci' }
const definitions = [{ name: 'users', ddl: 'CREATE TABLE users (id int NOT NULL)' }, { name: 'profiles', ddl: 'CREATE TABLE profiles (id bigint)' }]

describe('V4 schema parity fingerprint', () => {
  it('is stable for ordering and line endings, without exposing DDL', () => {
    const expected = schemaFingerprint(schema, definitions)
    expect(schemaFingerprint(schema, [...definitions].reverse())).toEqual(expected)
    expect(schemaFingerprint(schema, [{ name: 'users', ddl: 'CREATE TABLE users (\r\nid int)' }]))
      .toEqual(schemaFingerprint(schema, [{ name: 'users', ddl: 'CREATE TABLE users (\nid int)' }]))
    expect(expected.tableCount).toBe(2)
    expect(expected.tables[0]).toEqual({ name: 'profiles', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(JSON.stringify(expected)).not.toContain('CREATE TABLE')
  })
  it('detects changed columns and schema collation', () => {
    const original = schemaFingerprint(schema, definitions).sha256
    expect(schemaFingerprint({ ...schema, collation_name: 'utf8mb4_bin' }, definitions).sha256).not.toBe(original)
    expect(schemaFingerprint(schema, [{ ...definitions[0], ddl: definitions[0].ddl.replace('int', 'bigint') }, definitions[1]]).sha256).not.toBe(original)
    expect(schemaFingerprint(schema, [{ name: 'users', ddl: 'CREATE TABLE users (id int) AUTO_INCREMENT=2' }]).sha256)
      .not.toBe(schemaFingerprint(schema, [{ name: 'users', ddl: 'CREATE TABLE users (id int) AUTO_INCREMENT=3' }]).sha256)
  })
  it('rejects duplicates and unsafe table identifiers', async () => {
    expect(() => schemaFingerprint(schema, [definitions[0], definitions[0]])).toThrow('schema_fingerprint_input_invalid')
    await expect(readSchemaFingerprint({ query: async sql => [sql.includes('SCHEMATA') ? [schema] : [{ table_name: 'other.users', table_type: 'BASE TABLE' }]] }))
      .rejects.toThrow('schema_fingerprint_table_invalid')
  })
})
