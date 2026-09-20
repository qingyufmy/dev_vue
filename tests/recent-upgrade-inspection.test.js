import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { classifyRecentSource, loadRecentSources, inspectRecentUpgrades } from '../scripts/lib/recent-upgrade-inspection.mjs'
const root = new URL('../',import.meta.url)
const actual = s => ({table:['BASE TABLE','InnoDB','utf8mb4_unicode_ci'],columns:s.columns,indexes:s.indexes,foreignKeys:s.foreignKeys,triggers:[],checks:[]})
describe('recent upgrade inspection',()=>{
  it('loads frozen 029–031 sources and preserves the existing 081 checksum',async()=>{
    const sources=await loadRecentSources(root)
    expect(sources).toHaveLength(3)
    expect(sources[0].checksum).toBe('e7e5ba695eba1502926f6457ab280b05fbda90d9aa71a09040edb02559f4199e')
    expect(new Set(sources.map(s=>s.id)).size).toBe(3)
  })
  it('requires reconciliation for matching unmanaged tables, never marks them complete',async()=>{
    for(const s of await loadRecentSources(root))expect(classifyRecentSource(s,actual(s))).toEqual({status:'reconciliation_required',differences:[]})
  })
  it('distinguishes absent, completed, interrupted, and corrupt history',async()=>{
    const [s]=await loadRecentSources(root)
    expect(classifyRecentSource(s,null).status).toBe('pending')
    expect(classifyRecentSource(s,actual(s),{checksum:s.checksum,status:'completed'}).status).toBe('completed')
    expect(classifyRecentSource(s,actual(s),{checksum:s.checksum,status:'started'}).status).toBe('recovery_required')
    expect(classifyRecentSource(s,null,{checksum:s.checksum,status:'completed'}).status).toBe('history_conflict')
    expect(classifyRecentSource(s,actual(s),{checksum:'wrong',status:'completed'}).status).toBe('history_conflict')
  })
  it.each(['columns','indexes','foreignKeys','triggers','checks','table'])('rejects drift in %s even with completed history',async key=>{
    const s=(await loadRecentSources(root))[2]
    const observed=structuredClone(actual(s));observed[key].push('unexpected')
    expect(classifyRecentSource(s,observed,{checksum:s.checksum,status:'completed'})).toEqual({status:'schema_conflict',differences:[key]})
  })
  it('performs only SELECT statements and reports missing journal without creating one',async()=>{
    const queries=[]
    const db={async query(sql){queries.push(sql);if(sql.includes('server_uuid'))return [[{db:'test',uuid:'test',version:'8.4'}]];return [[]]},async execute(sql){queries.push(sql);return [[]]}}
    const r=await inspectRecentUpgrades(db,await loadRecentSources(root))
    expect(r).toMatchObject({writes:false,executable:false,journal:'missing'})
    expect(r.steps.every(s=>s.status==='pending')).toBe(true)
    expect(queries.every(q=>/^SELECT /i.test(q))).toBe(true)
  })
  it('rejects apply and unknown CLI arguments before connecting',()=>{
    const r=spawnSync(process.execPath,['scripts/inspect-recent-upgrades.mjs','--apply'],{cwd:new URL('../',import.meta.url),encoding:'utf8'})
    expect(r.status).toBe(1);expect(JSON.parse(r.stderr)).toMatchObject({writes:false,status:'inspection_failed'})
  })
})
