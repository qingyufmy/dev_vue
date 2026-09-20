import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {isAbsolute} from 'node:path'
import {Script,createContext} from 'node:vm'
import {normalizeBarsForChan,detectFractals} from '../server/dist-v4/modules/market/domain/chan-v8/bars.js'
import {buildBis} from '../server/dist-v4/modules/market/domain/chan-v8/bis.js'
import {buildSegments} from '../server/dist-v4/modules/market/domain/chan-v8/segments.js'
import {buildCenters} from '../server/dist-v4/modules/market/domain/chan-v8/centers.js'
import * as pivot from '../server/dist-v4/modules/market/domain/chan-v8/pivot-lifecycle.js'
import * as biSummary from '../server/dist-v4/modules/market/domain/chan-v8/bi-summary.js'
import * as segmentSummary from '../server/dist-v4/modules/market/domain/chan-v8/segment-summary.js'
import * as centerSummary from '../server/dist-v4/modules/market/domain/chan-v8/center-summary.js'
import {buildLatestChanStructure} from '../server/dist-v4/modules/market/domain/chan-v8/latest-structure.js'
const [referencePath,destination]=process.argv.slice(2)
assert.ok(process.argv.length===4&&isAbsolute(referencePath)&&isAbsolute(destination))
const source=await readFile(referencePath,'utf8'),start=source.indexOf('const MIN_BARS_PER_BI'),end=source.indexOf('function capStructureConfidence(')
assert.ok(start>0&&end>start)
const pure=source.slice(start,end).replace("const DEBUG_CHAN = process.env.DEBUG_CHAN === '1'",'const DEBUG_CHAN = false')
assert.ok(!/\b(?:import|require|process|fetch)\b/.test(pure))
const context=createContext({})
new Script(`const round2=v=>Math.round(v*100)/100,round3=v=>Math.round(v*1000)/1000,round5=v=>Math.round(v*100000)/100000;${pure};globalThis.reference={inspectActivePivotLifecycle,buildDevelopingBi,summarizeBi,summarizeLatestConfirmedFractal,summarizeSegment,summarizeSegmentCandidate,summarizeCenter,summarizeBiCenter,buildLatestChanStructure}`)
 .runInContext(context,{timeout:1000})
const reference=context.reference,canonical=v=>JSON.parse(JSON.stringify(v)),sha=v=>createHash('sha256').update(v).digest('hex')
let seed=19,checks=0;const states={}
const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296}
const compare=(name,args,fn)=>{const result=fn(...args);assert.deepEqual(canonical(result),canonical(reference[name](...args)),name);checks++;return result}
for(let trial=0;trial<80;trial++) {
 const rates=Array.from({length:trial<3?trial:250},(_,i)=>{const close=2000+Math.sin(i/4)*10+Math.sin(i/19)*8+next()*2;return {open:close-0.1,close,high:close+1,low:close-1,time:'t'+i,time_utc_msc:1700000000000+i*300000}})
 const bars=normalizeBarsForChan(rates),fractals=detectFractals(bars),strokes=buildBis(fractals,bars),segments=buildSegments(strokes.bis)
 // Reuse an earlier pivot in half the cases to cover its origin breaking later.
 const activePivot=trial%2===0?(fractals[0]??null):strokes.activePivot
 const lifecycle=compare('inspectActivePivotLifecycle',[activePivot,rates],pivot.inspectActivePivotLifecycle)
 states[lifecycle.state]=(states[lifecycle.state]||0)+1
 const developing=compare('buildDevelopingBi',[activePivot,rates,lifecycle],pivot.buildDevelopingBi)
 compare('summarizeBi',[strokes.bis.at(-1),rates],biSummary.summarizeBi)
 compare('summarizeBi',[developing,rates],biSummary.summarizeBi)
 compare('summarizeLatestConfirmedFractal',[fractals,bars,rates],biSummary.summarizeLatestConfirmedFractal)
 const current=compare('summarizeSegment',[segments.segments.at(-1),strokes.bis,rates],segmentSummary.summarizeSegment)
 const candidate=compare('summarizeSegmentCandidate',[segments.candidate,strokes.bis,rates,(segments.segments.at(-1)?.id??0)+1],segmentSummary.summarizeSegmentCandidate)
 compare('summarizeCenter',[buildCenters(segments.segments).at(-1),'M5',segments.segments,strokes.bis,rates],centerSummary.summarizeCenter)
 compare('summarizeBiCenter',[buildCenters(strokes.bis,{componentLevel:'bi'}).at(-1),'M5',strokes.bis,rates],centerSummary.summarizeBiCenter)
 const input={fractals,activePivot,activePivotLifecycle:lifecycle,normalizedBars:bars,rates,currentBi:strokes.bis.at(-1)??null,developingBi:developing,currentSegment:current,candidateSegment:candidate}
 const before=canonical(input)
 compare('buildLatestChanStructure',[input],buildLatestChanStructure)
 assert.deepEqual(canonical(input),before)
}
assert.ok(states.active>0&&states.origin_breached>0&&states.unavailable>0)
const targetHashes=[];for(const name of ['pivot-lifecycle','bi-summary','segment-summary','center-summary','latest-structure']){const path=`server/src/modules/market/domain/chan-v8/${name}.ts`;targetHashes.push({path,sha256:sha(await readFile(path))})}
const report={kind:'chan-v8-lifecycle-parity/v1',passed:true,checks,states,referenceSha256:sha(source),pureRangeSha256:sha(pure),targetHashes,scope:'synthetic lifecycle and summaries only; no full window or Worker validation',observedAt:new Date().toISOString()}
await writeFile(destination,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify(report))
