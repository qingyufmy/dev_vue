import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { Script, createContext } from 'node:vm'
import * as features from '../server/dist-v4/modules/market/domain/chan-v8/features.js'
import * as segments from '../server/dist-v4/modules/market/domain/chan-v8/segments.js'
import { buildCenters } from '../server/dist-v4/modules/market/domain/chan-v8/centers.js'

const [referencePath, destination] = process.argv.slice(2)
assert.ok(process.argv.length === 4 && isAbsolute(referencePath) && isAbsolute(destination))
const source = await readFile(referencePath, 'utf8')
const start = source.indexOf('function rangesOverlap('), end = source.indexOf('// === Chan Theory: Divergence Detection')
assert.ok(start > 0 && end > start)
const pure = source.slice(start, end)
assert.ok(!/\b(?:import|require|process|fetch)\b/.test(pure))
const context = createContext({})
new Script(`const MIN_BIS_PER_SEGMENT=3; const DEBUG_CHAN=false; ${pure}
globalThis.reference={normalizeFeatureSequence,findFeatureFractals,findFeatureFractalCandidates,evaluateGapEndpointConfirmation,pendingSegmentConfirmation,findSegmentEndpoint,buildSegmentsFromAnchor,buildSegments,buildCenters}`)
 .runInContext(context, { timeout: 1000 })
const old = context.reference
const canonical = value => JSON.parse(JSON.stringify(value))
const sha = value => createHash('sha256').update(value).digest('hex')
let seed = 77113, checks = 0, nonemptySegments = 0, nonemptyCenters = 0, resynced = 0
const next = () => { seed=(Math.imul(seed,1664525)+1013904223)>>>0; return seed/4294967296 }
const compare = (name, value, args) => { assert.deepEqual(canonical(value), canonical(old[name](...args)),name); checks++ }
for(let trial=0;trial<40;trial++) {
 let price=100
 const bis=Array.from({length:trial<4?trial:60},(_,i)=>{
  const start=price, dir=i%2===0?'up':'down'
  price+=(dir==='up'?1:-1)*(1+next()*20)
  return {id:i+1,dir,run_id:1,start_idx:i*5,end_idx:(i+1)*5,raw_start_idx:i*5,raw_end_idx:(i+1)*5,
    start_price:start,end_price:price,high:Math.max(start,price),low:Math.min(start,price),confirmed:true}
 })
 const before=canonical(bis)
 const raw=bis.map((bi,index)=>({source_start_index:index,source_end_index:index,high_source_index:index,low_source_index:index,high:bi.high,low:bi.low,start_price:bi.start_price,end_price:bi.end_price}))
 compare('normalizeFeatureSequence',features.normalizeFeatureSequence(raw),[raw])
 for(const direction of ['up','down']) {
  for(const name of ['findFeatureFractals','findFeatureFractalCandidates'])compare(name,features[name](raw,direction),[raw,direction])
  for(const name of ['evaluateGapEndpointConfirmation','pendingSegmentConfirmation','findSegmentEndpoint'])compare(name,features[name](bis,0,direction),[bis,0,direction])
 }
 for(const trustedStart of [true,false]) {
  const options={trustedStart}
  compare('buildSegmentsFromAnchor',segments.buildSegmentsFromAnchor(bis,options),[bis,options])
  const result=segments.buildSegments(bis,options)
  compare('buildSegments',result,[bis,options])
  if(result.segments.length)nonemptySegments++
  if(result.resynced)resynced++
  const centers=buildCenters(result.segments)
  compare('buildCenters',centers,[result.segments]);if(centers.length)nonemptyCenters++
 }
 for(const leadingSegmentIsEntry of [true,false]) {
  const options={componentLevel:'bi',leadingSegmentIsEntry},result=buildCenters(bis,options)
  compare('buildCenters',result,[bis,options]);if(result.length)nonemptyCenters++
 }
 assert.deepEqual(canonical(bis),before)
}
assert.ok(nonemptySegments>0 && nonemptyCenters>0 && resynced>0)
const targetHashes=[]
for(const name of ['types','features','segments','centers']) {
 const path=`server/src/modules/market/domain/chan-v8/${name}.ts`
 targetHashes.push({path,sha256:sha(await readFile(path))})
}
const report={kind:'chan-v8-structure-parity/v1',passed:true,checks,nonemptySegments,nonemptyCenters,resynced,
 referenceSha256:sha(source),pureRangeSha256:sha(pure),targetHashes,
 scope:'synthetic feature/segment/center parity only; divergence and full v8 runtime not covered',observedAt:new Date().toISOString()}
await writeFile(destination,JSON.stringify(report,null,2)+'\n',{flag:'wx'})
console.log(JSON.stringify(report))
