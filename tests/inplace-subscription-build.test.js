import { describe, expect, it } from 'vitest'
import { loadSubscriptionBuild, subscriptionBuildNames, executeSubscriptionBuild } from '../scripts/lib/inplace-subscription-build.mjs'

const root = new URL('../', import.meta.url)
const time = '2026-09-07T00:00:00Z'
async function fixture() {
  const plan = await loadSubscriptionBuild(root)
  const rows = plan.priorSteps.map(step => ({ id: step.id, checksum: step.checksum, status: 'completed', startedAt: time, completedAt: time }))
  const tables = new Map(), executed = []
  const store = { history: async () => rows, assertPrerequisites: async () => {}, tableHash: async name => tables.get(name) ?? null,
    begin: async step => rows.push({ id: step.id, checksum: step.checksum, status: 'started', startedAt: time, completedAt: null }),
    execute: async sql => { const step = plan.steps.find(item => item.sql === sql); tables.set(step.table, step.afterHash); executed.push(step.id) },
    complete: async step => Object.assign(rows.find(row => row.id === step.id), { status: 'completed', completedAt: time }) }
  return { plan, rows, tables, executed, store }
}

describe('subscription build migration', () => {
  it('binds the live reference and all prior migrations without referencing legacy accounts or subscriptions', async () => {
    const { plan } = await fixture()
    expect(plan.priorSteps).toHaveLength(26)
    expect(plan.steps.map(step => step.table)).toEqual(subscriptionBuildNames)
    const sql = plan.steps.map(step => step.sql).join('\n')
    expect(sql).toContain('REFERENCES `trading_accounts_v4_build`')
    expect(sql).toContain('REFERENCES `strategy_subscriptions_v4_build`')
    expect(sql).toContain('REFERENCES `strategy_versions`')
    expect(sql).not.toMatch(/REFERENCES `(trading_accounts|strategy_subscriptions)`|ON DELETE CASCADE|DROP TABLE/)
    const constraints = [...sql.matchAll(/CONSTRAINT `([^`]+)`/g)].map(match => match[1])
    expect(new Set(constraints).size).toBe(constraints.length)
    expect(constraints.every(name => name.startsWith('build_sub_') && name.length <= 64)).toBe(true)
  })
  it('plans without writes, then applies once and repeats without DDL', async () => {
    const f = await fixture()
    await executeSubscriptionBuild(f.store, f.plan)
    expect(f.executed).toHaveLength(0)
    await executeSubscriptionBuild(f.store, f.plan, { apply: true })
    await executeSubscriptionBuild(f.store, f.plan, { apply: true })
    expect(f.executed).toHaveLength(3)
    expect(f.rows).toHaveLength(29)
  })
  it.each([0, 1, 2])('recovers a lost DDL response for build table %i without replay', async index => {
    const f = await fixture(), execute = f.store.execute
    f.store.execute = async sql => { await execute(sql); if (sql === f.plan.steps[index].sql) throw new Error('lost_response') }
    await expect(executeSubscriptionBuild(f.store, f.plan, { apply: true })).rejects.toThrow('lost_response')
    f.store.execute = execute
    expect((await executeSubscriptionBuild(f.store, f.plan, { apply: true })).steps[index].status).toBe('reconciled')
    expect(f.executed).toHaveLength(3)
  })
  it('refuses a conflicting unjournaled table before any mutation', async () => {
    const f = await fixture()
    f.tables.set(f.plan.steps[2].table, f.plan.steps[2].afterHash)
    await expect(executeSubscriptionBuild(f.store, f.plan, { apply: true })).rejects.toThrow('schema_conflict')
    expect(f.executed).toHaveLength(0)
    expect(f.rows).toHaveLength(26)
  })
})
