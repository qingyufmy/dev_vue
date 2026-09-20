import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {isAbsolute} from 'node:path'
import {Script,createContext} from 'node:vm'
import * as trend from '../server/dist-v4/modules/market/domain/chan-v8/trend.js'
import {detectChanEntryCandidates} from '../server/dist-v4/modules/market/domain/chan-v8/entry-candidates.js'
import {summarizeSegment} from '../server/dist-v4/modules/market/domain/chan-v8/segment-summary.js'
import {divergenceResult} from '../server/dist-v4/modules/market/domain/chan-v8/divergence-result.js'
const [referencePath,destination]=process.argv.slice(2)
assert.ok(process.argv.length===4&&isAbsolute(referencePath)&&isAbsolute(destination))
const source=await readFile(referencePath,'utf8'),a=source.indexOf('const MIN_BARS_PER_BI'),b=source.indexOf('function emptyDivergence(')
assert.ok(a>0&&b>a)
const pure=source.slice(a,b).replace("const DEBUG_CHAN = process.env.DEBUG_CHAN === '1'",'const DEBUG_CHAN = false')
assert.ok(!/\b(?:import|require|process|fetch)\b/.test(pure))
const context=createContext({})
new Script(`const round2=v=>Math.round(v*100)/100,round3=v=>Math.round(v*1000)/1000,round5=v=>Math.round(v*100000)/100000;${pure};globalThis.reference={classifyChanTrendBackground,prioritizeLatestChanStructure,classifyChanTrend,detectChanEntryCandidates}`)
 .runInContext(context,{timeout:1000})
const old=context.reference,canonical=v=>JSON.parse(JSON.stringify(v)),sha=v=>createHash('sha256').update(v).digest('hex')
let checks=0;const entries=new Set(),states=new Set()
const compare=(name,args,fn)=>{const result=fn(...args);assert.deepEqual(canonical(result),canonical(old[name](...args)),name);checks++;return result}
for(const sign of [1,-1])for(const kind of ['first','second','third'])for(const reliability of ['low','medium','high'])for(const fresh of [true,false]) {
 const dir=value=>sign===1?value:value==='up'?'down':'up'
 const make=(id,d,start,end)=>({id,dir:dir(d),bi_ids:[id*3,id*3+1,id*3+2],weak:false,start_price:sign*start,end_price:sign*end,high:Math.max(sign*start,sign*end),low:Math.min(sign*start,sign*end)})
 const segments=[make(1,'up',100,120),make(2,'down',120,108),make(3,'up',108,130)]
 if(kind==='second')segments.push(make(4,'down',130,112),make(5,'up',112,125))
 if(kind==='third')segments.push(make(4,'down',130,125))
 const bis=segments.flatMap(s=>s.bi_ids.map((id,j)=>({id,dir:s.dir,run_id:1,start_idx:id,end_idx:id,raw_start_idx:id,raw_end_idx:id,high:s.high,low:s.low,start_price:s.start_price,end_price:s.end_price,confirmed:true})))
 const rates=Array.from({length:fresh?22:100},(_,i)=>({open:100,high:101,low:99,close:100,time:'t'+i,time_utc_msc:1700000000000+i*60000}))
 const center={id:8,component_level:'segment',status:'closed',zl:Math.min(sign*108,sign*120),zh:Math.max(sign*108,sign*120),entry_segment_id:1,departure_segment_id:3,closed_by_segment_id:3,start_segment_id:2,end_segment_id:2,segment_ids:[2],fluctuation_low:sign*108,fluctuation_high:sign*120}
 const div=divergenceResult('macd_area_and_height_divergence',{type:sign===1?'top':'bottom',confirmed:true,strength:'strong',entry_segment:summarizeSegment(segments[0],bis,rates),departure_segment:summarizeSegment(segments[2],bis,rates),price_extreme_cur:sign*130,center_id:8,departure_segment_id:3})
 const history=kind==='second'?[div]:[],current=kind==='first'?div:null
 const args=[segments,[center],current,history,bis,rates,reliability,true,null]
 const before=canonical(args),result=compare('detectChanEntryCandidates',args,detectChanEntryCandidates)
 result.forEach(item=>entries.add(item.type));assert.deepEqual(canonical(args),before)
 for(const price of [null,sign*90,sign*115,sign*140]) {
  const background=compare('classifyChanTrendBackground',[segments,[center],price,current,reliability,null],trend.classifyChanTrendBackground)
  states.add(background.state)
  for(const active_pivot_state of ['active','origin_breached']) {
   const latest={confirmed_direction:dir('up'),developing_direction:dir('down'),active_pivot_state,local_bias:dir('down'),latest_confirmed_fractal:{type:sign===1?'top':'bottom'}}
   compare('prioritizeLatestChanStructure',[background,latest,reliability],trend.prioritizeLatestChanStructure)
   compare('classifyChanTrend',[segments,[center],price,current,reliability,null,latest],trend.classifyChanTrend)
  }
 }
}
assert.deepEqual([...entries].sort(),['first_buy','first_sell','second_buy','second_sell','third_buy','third_sell'])
const targetHashes=[];for(const name of ['trend','entry-candidates']){const path=`server/src/modules/market/domain/chan-v8/${name}.ts`;targetHashes.push({path,sha256:sha(await readFile(path))})}
const report={kind:'chan-v8-trend-entry-parity/v1',passed:true,checks,entryTypes:[...entries].sort(),backgroundStates:[...states].sort(),referenceSha256:sha(source),pureRangeSha256:sha(pure),targetHashes,scope:'synthetic trend/entry parity only; no full window, execution permission or Worker integration',observedAt:new Date().toISOString()}
await writeFile(destination,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(report))
