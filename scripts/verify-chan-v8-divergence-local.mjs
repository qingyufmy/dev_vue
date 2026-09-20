import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {isAbsolute} from 'node:path'
import {Script,createContext} from 'node:vm'
import * as divergence from '../server/dist-v4/modules/market/domain/chan-v8/divergence.js'
import * as forming from '../server/dist-v4/modules/market/domain/chan-v8/forming-divergence.js'
import {divergenceResult} from '../server/dist-v4/modules/market/domain/chan-v8/divergence-result.js'
const [referencePath,destination]=process.argv.slice(2)
assert.ok(process.argv.length===4&&isAbsolute(referencePath)&&isAbsolute(destination))
const source=await readFile(referencePath,'utf8')
const part=(start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a+1);assert.ok(a>=0&&b>a);return source.slice(a,b)}
const pure=[part('const MIN_BARS_PER_BI','const DEBUG_CHAN'),part('function roundMacdEvidence','// === Chan Theory: Normalize'),part('function inspectSegmentCandidateLifecycle','function rangesOverlap'),part('const DETERMINISTIC_NO_DIVERGENCE_REASONS','function buildFormingSegment'),part('function buildFormingSegment','function summarizeSegmentCandidate'),part('function detectFormingDivergence','function summarizeSegment('),part('function emptyDivergence','function buildChanEvidenceCapabilities')].join('\n')
assert.ok(!/\b(?:import|require|process|fetch)\b/.test(pure))
const context=createContext({})
new Script(`const round2=v=>Math.round(v*100)/100,round3=v=>Math.round(v*1000)/1000,round5=v=>Math.round(v*100000)/100000;${pure};globalThis.reference={evaluateDivergence,detectDivergence,detectDivergenceHistory,detectFormingDivergence,divergenceResult}`)
 .runInContext(context,{timeout:1000})
const old=context.reference,canonical=value=>JSON.parse(JSON.stringify(value)),sha=value=>createHash('sha256').update(value).digest('hex')
let checks=0;const outcomes={}
function compare(name,args,current){const result=current(...args);assert.deepEqual(canonical(result),canonical(old[name](...args)),name);checks++;if(result.state)outcomes[result.state]=(outcomes[result.state]||0)+1;return result}
for(const direction of ['up','down'])for(const ratio of [0,0.1,0.85,0.95,1,1.2])for(const warmup of [false,true])for(const centerPresent of [false,true]) {
 const sign=direction==='up'?1:-1
 const segments=[{id:2,dir:direction,bi_ids:[4,5,6],weak:false,high:125,low:95,start_price:100,end_price:120},
 {id:3,dir:direction==='up'?'down':'up',bi_ids:[7,8,9],weak:false,high:118,low:100,start_price:118,end_price:100},
 {id:4,dir:direction,bi_ids:[10,11,12],weak:false,high:130,low:90,start_price:100,end_price:direction==='up'?130:90}]
 const bis=Array.from({length:9},(_,i)=>({id:i+4,dir:direction,run_id:1,start_idx:i,end_idx:i,raw_start_idx:(warmup?20:40)+i,raw_end_idx:(warmup?20:40)+i,high:i<6?125:130,low:i<6?95:90,start_price:100,end_price:110,confirmed:true}))
 const hist=Array(60).fill(0),dif=Array(60).fill(0),dea=Array(60).fill(0)
 bis.forEach((bi,i)=>{hist[bi.raw_start_idx]=sign*(i<3?5:i>=6?5*ratio:0);dif[bi.raw_start_idx]=hist[bi.raw_start_idx];dea[bi.raw_start_idx]=hist[bi.raw_start_idx]})
 const centers=centerPresent?[{id:7,component_level:'segment',start_segment_id:3,end_segment_id:3,entry_segment_id:2,departure_segment_id:4,closed_by_segment_id:4,zl:100,zh:118}]:[]
 const rates=Array.from({length:60},(_,i)=>({open:100+i,high:101+i,low:99+i,close:100+i,time:'t'+i,time_utc_msc:1700000000000+i*60000}))
 const before=canonical({segments,bis,hist,centers,rates})
 for(const state of ['confirmed','forming'])compare('evaluateDivergence',[segments.at(-1),segments,bis,hist,centers,rates,state,{difSeries:dif,deaSeries:dea}],divergence.evaluateDivergence)
 compare('detectDivergence',[segments,bis,hist,centers,rates],divergence.detectDivergence)
 compare('detectDivergenceHistory',[segments,bis,hist,centers,rates],divergence.detectDivergenceHistory)
 const candidate={dir:direction,bi_ids:[10,11,12],start_price:100,end_price:direction==='up'?130:90}
 compare('detectFormingDivergence',[candidate,segments.slice(0,2),bis,hist,centers,rates],forming.detectFormingDivergence)
 assert.deepEqual(canonical({segments,bis,hist,centers,rates}),before)
}
for(const reason of ['macd_no_divergence','no_price_extreme_break','not_after_center','no_macd_data'])for(const state of ['forming','confirmed','unavailable'])compare('divergenceResult',[reason,{state}],divergenceResult)
assert.ok(outcomes.confirmed>0&&outcomes.forming>0&&outcomes.unavailable>0&&outcomes.evaluated>0)
const targetHashes=[];for(const name of ['divergence','divergence-result','forming-divergence','segment-location','rounding']){const path=`server/src/modules/market/domain/chan-v8/${name}.ts`;targetHashes.push({path,sha256:sha(await readFile(path))})}
const report={kind:'chan-v8-divergence-parity/v1',passed:true,checks,outcomes,referenceSha256:sha(source),pureRangeSha256:sha(pure),targetHashes,scope:'synthetic divergence results and lifecycle parity; complete v8/Worker not covered',observedAt:new Date().toISOString()}
await writeFile(destination,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(report))
