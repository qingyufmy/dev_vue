import { tableDefinitionHash } from '../scripts/lib/inplace-foundation-upgrade.mjs'
import { expect, it } from 'vitest'
import { loadRuntimeIndexCoordinator, removeRuntimeIndexDefinitions, runtimeIndexObservedHash } from '../scripts/lib/inplace-runtime-index-schema.mjs'
import { loadModelCheckCoordinator } from '../scripts/lib/inplace-model-check-schema.mjs'
import { coordinateInplaceSchema } from '../scripts/lib/inplace-schema-coordinator.mjs'

const root = new URL('../', import.meta.url), plan = await loadRuntimeIndexCoordinator(root)
it('preserves all prior checksums', async () => { expect(plan.steps.slice(0,133)).toEqual((await loadModelCheckCoordinator(root)).steps);expect(plan.steps).toHaveLength(139) })
it.each(plan.steps.slice(133).map(step => [step.id]))('recovers %s without repeating ALTER or resetting prior column changes', async id => {
  const rows = plan.steps.slice(0, 133).map(step => ({ id: step.id, checksum: step.checksum, status: 'completed', startedAt: '2026-09-08T00:00:00Z', completedAt: '2026-09-08T00:00:00Z' }))
  const states = new Map(), executed = []
  plan.transitions.forEach((row, index) => { if (index < 133) states.set(row.key, row.after); else if (!states.has(row.key)) states.set(row.key, row.before) })
  const execute = async sql => { const row = plan.transitions.find(item => item.step.sql === sql); states.set(row.key, row.after); executed.push(row.step.id) }
  const store = { history: async () => rows, column: async (table, column) => states.get(`${table}.${column}`) ?? null,
    tableHash: async table => states.get(table) ?? null,
    begin: async step => rows.push({ id: step.id, checksum: step.checksum, status: 'started', startedAt: '2026-09-08T00:00:00Z', completedAt: null }),
    execute: async sql => { await execute(sql); if (executed.at(-1) === id) throw Error('lost_ack') },
    complete: async step => Object.assign(rows.find(row => row.id === step.id), { status: 'completed', completedAt: '2026-09-08T00:00:00Z' }) }
  await expect(coordinateInplaceSchema(store, plan, { apply: true })).rejects.toThrow('lost_ack')
  store.execute = execute
  expect((await coordinateInplaceSchema(store, plan, { apply: true })).steps.find(row => row.id === id).status).toBe('reconciled')
  expect((await coordinateInplaceSchema(store, plan, { apply: true })).structureComplete).toBe(true)
  expect(executed).toHaveLength(6)
})

it('preserves immutable checksums while accommodating MySQL unique-index display order', () => {
const additions=plan.transitions.slice(133)
for(const row of additions){
 const lines=row.afterDefinition.split('\n'),keys=lines.filter(line=>/^  (?:UNIQUE )?KEY /.test(line));const first=lines.findIndex(line=>/^  (?:UNIQUE )?KEY /.test(line));
 const sorted=[...keys.filter(line=>line.startsWith('  UNIQUE ')),...keys.filter(line=>line.startsWith('  KEY '))];const following=lines[first+keys.length];
 lines.splice(first,keys.length,...sorted.map((line,i)=>line.replace(/,$/,'')+(i<sorted.length-1||following.startsWith('  CONSTRAINT ')?',':'')))
 const physical=lines.join('\n')
 expect(runtimeIndexObservedHash(row.step.table,physical,additions)).toBe(row.after)
 if(row.step.table==='bridge_refresh_sessions') expect(runtimeIndexObservedHash(row.step.table,physical.replace('migration_key\x60)','migration_key\x60 DESC)'),additions)).not.toBe(row.after)
}
})
it('removes only new index descriptors and keeps all original schema bytes',()=>{
 const additions=plan.transitions.slice(133)
 for(const name of new Set(additions.map(r=>r.step.table))){const rows=additions.filter(r=>r.step.table===name);expect(removeRuntimeIndexDefinitions(name,rows.at(-1).afterDefinition,additions)).toBe(rows[0].beforeDefinition)}
})
