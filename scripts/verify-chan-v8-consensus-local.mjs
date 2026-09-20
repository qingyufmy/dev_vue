import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { Script, createContext } from 'node:vm'
import * as windows from '../server/dist-v4/modules/market/domain/chan-v8/window-evidence.js'
import * as segments from '../server/dist-v4/modules/market/domain/chan-v8/segment-consensus.js'
import * as centers from '../server/dist-v4/modules/market/domain/chan-v8/center-consensus-evidence.js'
import { selectConsensusCenters } from '../server/dist-v4/modules/market/domain/chan-v8/center-consensus.js'
import * as bootstrap from '../server/dist-v4/modules/market/domain/chan-v8/bootstrap-consensus.js'
const [referencePath,destination]=process.argv.slice(2)
assert.ok(process.argv.length===4&&isAbsolute(referencePath)&&isAbsolute(destination))
const source=await readFile(referencePath,'utf8'),start=source.indexOf('function stableTerminalStructureKey('),end=source.indexOf('const CONCLUSIVE_FORMING_NONE_REASONS')
assert.ok(start>0&&end>start)
const pure=source.slice(start,end),current={...windows,...segments,...centers,selectConsensusCenters,...bootstrap}
assert.ok(!/\b(?:import|require|process|fetch)\b/.test(pure))
const context=createContext({})
new Script(`const round5=v=>Math.round(v*100000)/100000;${pure};globalThis.reference={${Object.keys(current).join(',')}}`).runInContext(context,{timeout:1000})
const canonical=v=>JSON.parse(JSON.stringify(v)),sha=v=>createHash('sha256').update(v).digest('hex')
let checks=0,nonemptyChains=0,nonemptyCenters=0
const compare=(name,args)=>{const before=canonical(args),actual=current[name](...args);assert.deepEqual(canonical(actual),canonical(context.reference[name](...args)),name);assert.deepEqual(canonical(args),before,name+' mutation');checks++;return actual}
const chain=Array.from({length:7},(_,i)=>({id:i+1,stable_id:'s'+i,dir:i%2?'down':'up',start_time_utc_msc:200000+i*1000,end_time_utc_msc:200900+i*1000,start_price:105,end_price:108,low:100,high:110,start_index:i*3,end_index:i*3+2}))
chain[6]={...chain[6],low:115,high:120,start_price:115,end_price:120}
const center={id:1,core_stable_id:'s1|s2|s3',core_segment_stable_ids:['s1','s2','s3'],start_segment_stable_id:'s1',entry_segment_stable_id:'s0',entry_segment_start_time_utc_msc:200000}
const make=(ids=chain)=>({_confirmed_segments:ids,_confirmed_centers:[center],current_segment:ids.at(-1),prev_segment:ids.at(-2),latest_center:center,
 window_stable:true,segment_count:ids.length,raw_bar_count:2000,window_start_time_utc_msc:100000,_closed_rate_times_utc_msc:Array.from({length:300},(_,i)=>100000+i*1000),
 window_end_time_utc_msc:400000,structure_time_key_reliable:true,history_sufficient:true,closed_history_sufficient:true,reliability:'medium'})
for(const count of [0,1,2,3,4])for(const dissent of [0,1,2])for(const contextBars of [0,100,150]){
 const all=Array.from({length:count},(_,i)=>i<dissent?{...make(chain.slice(-2)),_confirmed_centers:[],latest_center:null}:make())
 const winners=all.filter(c=>c._confirmed_centers.length)
 const consensus=compare('buildCrossWindowConsensusSegments',[winners,all]);if(consensus.segments.length)nonemptyChains++
 const selected=compare('selectConsensusCenters',[winners,all,chain,'M5',all.at(-1)||null,contextBars]);if(selected.centers.length)nonemptyCenters++
 for(const c of all){compare('stableTerminalStructureKey',[c]);compare('terminalEvidenceStart',[c]);compare('candidateEndsWithSegmentChain',[c,chain.slice(-2)]);compare('windowHasEvidenceContext',[c,201000,contextBars])}
}
for(const raw of [null,center,{...center,core_segment_stable_ids:[],core_stable_id:null},{...center,core_segment_stable_ids:[],core_stable_id:'x|y|z'}]){
 compare('centerCoreStableIds',[raw,make()]);compare('stableCenterCoreKey',[raw,make()])
}
for(const ids of [[],['missing','s2','s3'],['s1','s2','s3'],['s4','s5','s6']])compare('rebuildConsensusCenterFromCore',[ids,chain])
// Hidden empty center evidence is authoritative and cannot fall back to the visible latest center.
assert.deepEqual(compare('confirmedCenterEvidence',[{...make(),_confirmed_centers:[]}]),[])
const stableSnapshots=[0,1,2].map(i=>({...make(),window_end_time_utc_msc:400000+i*1000}))
for(const snapshots of [[],[make()],stableSnapshots,[make(),make(),make()],[stableSnapshots[0],null,stableSnapshots[2]],stableSnapshots.map(c=>({...c,cache_internal_gap_unresolved:true}))]){
 const result=compare('summarizeTemporalBootstrapEvidence',[snapshots])
 compare('evaluateCrossWindowBootstrapEvidence',[[make(),make(),make()],make(),result,100])
}
assert.equal(bootstrap.summarizeTemporalBootstrapEvidence(stableSnapshots).temporal_identity_stable,true)
assert.equal(bootstrap.summarizeTemporalBootstrapEvidence([make(),make(),make()]).temporal_identity_stable,false)
assert.equal(selectConsensusCenters([make()],[make()],chain,'M5',make()).centers.length,0)
assert.ok(nonemptyChains>0&&nonemptyCenters>0)
const sources={}
for(const name of ['window-evidence','segment-consensus','center-consensus-evidence','center-consensus','bootstrap-consensus'])sources[name]=sha(await readFile(`server/src/modules/market/domain/chan-v8/${name}.ts`))
const report={passed:true,checks,nonemptyChains,nonemptyCenters,referenceSha256:sha(source),sources,scope:'Synthetic quorum/authority/context and distinct-observation parity; pure modules only. Final evidence remapping/selection and Worker not wired.'}
await writeFile(destination,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(report))
