import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { Script, createContext } from 'node:vm'
import { computeChanWindow } from '../server/dist-v4/modules/market/domain/chan-v8/compute-window.js'
import { calculateMacdSeries } from '../server/dist-v4/modules/market/domain/chan-v8/macd.js'
const [referencePath,destination]=process.argv.slice(2)
assert.ok(process.argv.length===4&&isAbsolute(referencePath)&&isAbsolute(destination))
const source=await readFile(referencePath,'utf8'),a=source.indexOf('const MIN_BARS_PER_BI'),b=source.indexOf('function stableTerminalStructureKey(')
assert.ok(a>0&&b>a)
const pure=source.slice(a,b).replace("const DEBUG_CHAN = process.env.DEBUG_CHAN === '1'",'const DEBUG_CHAN = false')
assert.ok(!/\b(?:import|require|process|fetch)\b/.test(pure))
const context=createContext({})
new Script(`const CHAN_ALGORITHM_VERSION='chan_structure_v8'; const round2=v=>Math.round(v*100)/100,round3=v=>Math.round(v*1000)/1000,round5=v=>Math.round(v*100000)/100000;${pure};globalThis.reference=computeChanWindow`).runInContext(context,{timeout:1000})
const canonical=v=>JSON.parse(JSON.stringify(v)),sha=v=>createHash('sha256').update(v).digest('hex')
let seed=912,checks=0,nonemptySegments=0,nonemptyCenters=0
const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296}
const states=new Set()
const variants=[{}, {requestedHistoryCount:2000},
 {dataQuality:{platform:'mt5',source_id:1,clock_status:'verified',last_bar_closed:true}},
 {dataQuality:{platform:'mt5',source_id:1,clock_status:'unknown',last_bar_closed:false}},
 {dataQuality:{platform:'mt5',source_id:1,clock_status:'verified',continuity_status:'suspicious_gap',cache_internal_gap_unresolved:true}},
 {dataQuality:{platform:'mt4',source_id:1,clock_status:'mt4_current_offset',timezone_offset_minutes:180,clock_sample_age_ms:1000}},
 {dataQuality:{platform:'mt4',source_id:1,clock_status:'mt4_cached_offset',timezone_offset_minutes:180,clock_sample_age_ms:999999}},
 {trustedStructureAnchorUtcMs:1700000000000,trustedStructureAnchor:{bootstrap_core_stable_id:'missing',bootstrap_entry_segment_stable_id:'missing',last_confirmed_segment_time_utc_msc:1700000000000}}]
for(const count of [0,1,29,30,31,100,300,1000,1800,2000])for(let trial=0;trial<4;trial++){
 const rates=Array.from({length:count},(_,i)=>{const price=100+Math.sin(i/(4+trial))*10+Math.sin(i/41)*15+random()*3;return {open:price-0.3,close:price,high:price+1,low:price-1,time:'t'+i,time_utc_msc:1700000000000+i*300000}})
 const macd=calculateMacdSeries(rates.map(r=>r.close))
 for(const options of variants){
  assert.equal(macd.histSeries.length,rates.length)
  const args=[rates,'M5',macd.histSeries,options],before=canonical(args)
  const actual=computeChanWindow(...args),expected=context.reference(...args)
  assert.deepEqual(canonical(actual),canonical(expected),`window count=${count} trial=${trial} options=${JSON.stringify(options)}`)
  for(const key of ['_confirmed_segments','_confirmed_centers','_closed_rate_times_utc_msc']){
   assert.equal(Object.hasOwn(actual,key),Object.hasOwn(expected,key))
   if(Object.hasOwn(expected,key)) { assert.deepEqual(canonical(actual[key]),canonical(expected[key]));assert.equal(Object.getOwnPropertyDescriptor(actual,key).enumerable,false) }
  }
  assert.deepEqual(canonical(args),before)
  checks++;states.add(actual.status);if(actual.segment_count>0)nonemptySegments++;if(actual.center_count>0)nonemptyCenters++
 }
}
assert.ok(nonemptySegments>0&&nonemptyCenters>0)
const files=['compute-window','evidence-capabilities','empty-result'],sources={}
for(const name of files)sources[name]=sha(await readFile(`server/src/modules/market/domain/chan-v8/${name}.ts`))
const report={passed:true,checks,nonemptySegments,nonemptyCenters,statuses:[...states],referenceSha256:sha(source),sources,
 scope:'Pure single-window v8 parity with synthetic prices and quality metadata; includes nonenumerable consensus inputs and input immutability. No cross-window consensus, Worker wiring or terminal/runtime validation.'}
await writeFile(destination,JSON.stringify(report,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify(report))
