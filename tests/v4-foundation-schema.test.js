import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const migrations = join(root, 'server/db/migrations')
const foundation = readFileSync(join(migrations, 'bootstrap/v4-foundation-v1.sql'), 'utf8')
const executable = source => source.replace(/--[^\n]*/g, '')
const numbered = readdirSync(migrations).filter(name => /^\d{8}_\d{3}_.*\.sql$/.test(name)).sort()
const allSql = [foundation, ...numbered.map(name => readFileSync(join(migrations, name), 'utf8'))]

describe('V4 explicit empty-database foundation', () => {
  it('provides seven prerequisite tables without activating any user, credential or worker', () => {
    const sql = executable(foundation)
    expect([...sql.matchAll(/CREATE TABLE (\w+)/g)].map(match => match[1])).toEqual([
      'users', 'bridge_refresh_sessions', 'ai_model_profiles', 'user_model_defaults',
      'ai_model_provider_capabilities', 'platform_model_usage_policy', 'ai_model_usage_logs',
    ])
    expect(sql).not.toMatch(/\b(?:INSERT|REPLACE|UPDATE|DELETE|DROP|TRUNCATE|USE|GRANT)\b/i)
    expect(sql).not.toMatch(/DATETIME(?!\(3\))/i)
    expect(sql).toContain("verification_status VARCHAR(24) NOT NULL DEFAULT 'unverified'")
    expect(sql).toContain("status VARCHAR(16) NOT NULL DEFAULT 'inactive'")
    expect(sql).toContain('PRIMARY KEY (user_id)')
  })

  it('resolves every declared table dependency in execution order', () => {
    const created = new Set()
    const missing = []
    for (const source of allSql) {
      for (const match of executable(source).matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+(\w+)|ALTER TABLE\s+(\w+)|REFERENCES\s+(\w+)/gi)) {
        if (match[1]) created.add(match[1])
        else if (!created.has(match[2] ?? match[3])) missing.push(match[2] ?? match[3])
      }
    }
    expect(missing).toEqual([])
  })

  it('covers all literal V4 runtime read and insert table references', () => {
    const created = new Set(allSql.flatMap(source => [...executable(source).matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+(\w+)/gi)].map(match => match[1])))
    const missing = new Set()
    for (const file of typescriptFiles(join(root, 'server/src'))) {
      for (const match of readFileSync(file, 'utf8').matchAll(/\b(?:FROM|JOIN|INSERT INTO)\s+([a-z][a-z0-9_]+)\b/g)) {
        if (!created.has(match[1])) missing.add(match[1])
      }
    }
    expect([...missing].sort()).toEqual([])
  })
})

function typescriptFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? typescriptFiles(path) : entry.name.endsWith('.ts') ? [path] : []
  })
}
