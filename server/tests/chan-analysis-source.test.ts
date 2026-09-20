import { describe, expect, it, vi } from 'vitest'
import { compileStrategy } from '../src/modules/strategies/application/strategy-service.js'
import { marketPlan } from '../src/modules/inference/application/analysis-context-builder.js'
import { TradingAnalysisMarketSource } from '../src/modules/inference/infrastructure/trading-analysis-market-source.js'
import { calculateChanMarketEvidence, captureChanCalculation, replayChanCalculation } from '../src/modules/market/index.js'
import { analysisModelSnapshot } from '../src/modules/inference/application/analysis-model-snapshot.js'
import type { AnalysisTradingReader } from '../src/modules/inference/index.js'
const now = '2026-09-12T12:00:00.000Z', end = Date.parse(now), count = 1800
const bars = Array.from({length:count},(_,i) => {
  const phase=i+25, close=100+Math.sin(phase*.02)*20+Math.sin(phase*.06)*10+Math.sin(phase*.35)*3
  return {accountId:'5',symbol:'XAUUSD',timeframe:'M5' as const,openTime:new Date(end-(count-i)*300000).toISOString(),
    open:String(close),high:String(close+1),low:String(close-1),close:String(close),tickVolume:'1',closed:true,revision:1}
})
const clock = {clockStatus:'calibrated',timezoneOffsetMinutes:180,observedAt:now}
const input = {timeframe:'M5',timeframeMs:300000,referenceTime:now,accountId:'5',platform:'mt5',clock}
describe('Chan analysis integration', () => {
  it('replays serialized complete calculation inputs and detects changed candles or expected output', () => {
    for (const context of [input,{...input,clock:null}]) {
      const {archive,evidence}=captureChanCalculation(bars,context)
      expect(archive.input.candles).toHaveLength(1800)
      expect(replayChanCalculation(JSON.parse(JSON.stringify(archive)))).toEqual(evidence)
      const changed=structuredClone(archive)
      changed.input.candles[0]!.close='9000'
      expect(()=>replayChanCalculation(changed)).toThrow('chan_archive_input_invalid')
      expect(()=>replayChanCalculation({...archive,outputSha256:'0'.repeat(64)})).toThrow('chan_archive_replay_mismatch')
    }
  })
  it('isolates the provider payload from durable audit data and mutable gateway code', () => {
    const snapshot={kind:'analysis' as const,strategy:{id:'1',versionId:'2',promptText:'prompt',promptHash:'hash'},
      market:{candles:{M5:[{close:'1'}]},calculation_archive:{M5:{secret:'full history'}}},macro:null,capturedAt:now}
    const visible=analysisModelSnapshot(snapshot)
    expect(visible.market).not.toHaveProperty('calculation_archive')
    expect(snapshot.market.calculation_archive.M5.secret).toBe('full history')
    visible.market.candles={}
    expect(snapshot.market.candles.M5).toHaveLength(1)
  })
  it('compiles an explicit switch and refuses unsupported configuration versions', () => {
    const config={timeframes:['M5'],candle_limit:100,chan_evidence:{version:1,enabled:true}}
    const compiled=compileStrategy('analysis','neutral analysis',config)
    expect(compiled.valid).toBe(true)
    expect(marketPlan(compiled.normalizedConfig).chan).toEqual(config.chan_evidence)
    expect(compileStrategy('analysis','neutral analysis',{...config,chan_evidence:{version:2,enabled:true}}).valid).toBe(false)
  })
  it('fetches the calculation history without enlarging the model candle window; disabling removes both', async () => {
    const listCandles=vi.fn(async (_account:string,_symbol:string,_timeframe:string,limit:number)=>bars.slice(-limit))
    const getAccountSnapshot=vi.fn(async()=>clock)
    const reader={findOwnedAccount:async()=>null,listAccounts:async()=>[{id:'5',bridgeState:'online',platform:'mt5',server:'fixture'}],
      getQuote:async()=>({bid:'100',ask:'101',observedAt:now}),listCandles,getAccountSnapshot} as unknown as AnalysisTradingReader
    const source=new TradingAnalysisMarketSource(reader)
    const scope={userId:7,preferredAccountId:null,symbol:'XAUUSD',referenceTime:now}
    const output=await source.read({...scope,plan:{timeframes:['M5'],candleLimit:100,chan:{version:1,enabled:true}}})
    expect(listCandles).toHaveBeenCalledWith('5','XAUUSD','M5',1800)
    expect(getAccountSnapshot).toHaveBeenCalledWith('5',7)
    expect(output.candles.M5).toHaveLength(100)
    const evidence=output.indicators?.chan?.M5 as Record<string,unknown>
    expect(evidence.algorithm_version).toBe('chan_structure_v8')
    expect(evidence.received_bars).toBe(1800)
    expect((output.calculation_archive?.M5 as Record<string,unknown>).input).toBeDefined()
    expect(JSON.stringify(evidence)).not.toContain('_confirmed_segments')
    const disabled=await source.read({...scope,plan:{timeframes:['M5'],candleLimit:100,chan:{version:1,enabled:false}}})
    expect(disabled.indicators).toBeUndefined()
    expect(disabled.calculation_archive).toBeUndefined()
    expect(listCandles).toHaveBeenLastCalledWith('5','XAUUSD','M5',100)
    expect(getAccountSnapshot).toHaveBeenCalledTimes(1)
  })
  it('does not promote unexplained gaps, invalid bars or an unavailable clock', () => {
    const unknownClock=calculateChanMarketEvidence(bars,{...input,clock:null})
    expect(unknownClock.reason).toBe('chan_clock_unavailable')
    expect((unknownClock.structure.evidence_capabilities as Record<string,unknown>).entry_structure_usable).toBe(false)
    const gap=calculateChanMarketEvidence([...bars.slice(0,100),...bars.slice(101)],input)
    expect(gap.reason).toBe('chan_history_gap_unresolved')
    expect((gap.structure.evidence_capabilities as Record<string,unknown>).data_complete).toBe(false)
    const invalid=calculateChanMarketEvidence([{...bars[0]!,closed:false},...bars.slice(1)],input)
    expect(invalid.reason).toBe('chan_candle_invalid')
    expect((invalid.structure.evidence_capabilities as Record<string,unknown>).data_complete).toBe(false)
  })
})

it('archives and replays daily public calibration while retaining missing-history rejection', () => {
  const context = { ...input, clock: { ...clock, dailyCalibration: true, observedAt: new Date(end - 12 * 3600_000).toISOString() } }
  const { archive, evidence } = captureChanCalculation(bars, context)
  expect(evidence.reason).not.toBe('chan_clock_unavailable')
  expect(replayChanCalculation(JSON.parse(JSON.stringify(archive)))).toEqual(evidence)
  expect(calculateChanMarketEvidence(bars, { ...context, clock: { ...context.clock, observedAt: new Date(end - 26 * 3600_000).toISOString() } }).reason).toBe('chan_clock_unavailable')
  expect(calculateChanMarketEvidence(bars.slice(0, 100).concat(bars.slice(101)), context).reason).toBe('chan_history_gap_unresolved')
})

it('replays terminal-confirmed gaps without accepting an unconfirmed interval', () => {
 const items=bars.slice(0,100).concat(bars.slice(101))
 const confirmedGaps=[{from:bars[99]!.openTime,to:bars[101]!.openTime}]
 const {archive,evidence}=captureChanCalculation(items,{...input,confirmedGaps})
 expect(evidence.reason).not.toBe('chan_history_gap_unresolved')
 expect(evidence.gap_policy).toBe('terminal_confirmed/v1')
 expect(replayChanCalculation(JSON.parse(JSON.stringify(archive)))).toEqual(evidence)
 expect(calculateChanMarketEvidence(items,{...input,confirmedGaps:[{from:bars[98]!.openTime,to:bars[101]!.openTime}]}).reason).toBe('chan_history_gap_unresolved')
})
