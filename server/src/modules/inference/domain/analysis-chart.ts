type RecordValue = Record<string, unknown>
const object = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
const number = (value: unknown) => typeof value === 'number' || typeof value === 'string' && value.trim() ? Number(value) : NaN
export function analysisChart(snapshot: unknown, replay?: (archive: unknown) => unknown) {
  const market = object(object(snapshot).market)
  const candles = object(market.candles), chan = object(object(market.indicators).chan)
  return Object.entries(candles).filter(([period]) => /^(M1|M5|M15|M30|H1|H4|D1)$/.test(period)).map(([timeframe, rows]) => {
    const archived = object(object(object(market.calculation_archive)[timeframe]).input).candles
    const source = Array.isArray(archived) ? archived : rows
    const bars = (Array.isArray(source) ? source : []).slice(-500).map(object).map(row => ({ time: String(row.open_time ?? row.openTime ?? ''), open: number(row.open), high: number(row.high), low: number(row.low), close: number(row.close), closed: row.closed === true })).filter(row => Number.isFinite(Date.parse(row.time)) && [row.open,row.high,row.low,row.close].every(Number.isFinite) && row.low <= Math.min(row.open,row.close) && row.high >= Math.max(row.open,row.close))
    const structure = object(object(chan[timeframe]).structure)
    const lines: { kind: string; from: string; to: string; start: number; end: number }[] = []
    let restored: RecordValue = {}
    try { if (replay) restored = object(replay(object(market.calculation_archive)[timeframe])) } catch { /* Keep frozen candles; never invent unavailable historical structures. */ }
    const candidate = object(structure.candidate_segment)
    const add = (kind: string, from: unknown, to: unknown, start: unknown, end: unknown) => {
      if (typeof from === 'string' && typeof to === 'string' && Date.parse(from) < Date.parse(to) && Number.isFinite(number(start)) && Number.isFinite(number(end))) lines.push({ kind, from, to, start: number(start), end: number(end) })
    }
    add('forming_segment', candidate.start_time, candidate.end_time, candidate.start_price, candidate.end_price)
    for (const segment of Array.isArray(restored._confirmed_segments) ? restored._confirmed_segments : []) {
      const row = object(segment)
      add('segment', row.start_time, row.end_time, row.start_price, row.end_price)
    }
    const iso = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : undefined
    for (const bi of Array.isArray(restored.recent_bis) ? restored.recent_bis : []) {
      const row = object(bi)
      if (row.confirmed === true) add('bi', iso(row.start_time_utc_msc), iso(row.end_time_utc_msc), row.start_price, row.end_price)
    }
    const fractal = object(object(restored.latest_structure).latest_confirmed_fractal)
    if (fractal.confirmed === true && ['top','bottom'].includes(String(fractal.type)) && iso(fractal.time_utc_msc) && Number.isFinite(number(fractal.price))) lines.push({ kind: `fractal_${fractal.type}`, from: iso(fractal.time_utc_msc)!, to: iso(fractal.time_utc_msc)!, start: number(fractal.price), end: number(fractal.price) })
    const center = object(structure.active_center)
    add('center', center.start_time, center.end_time, center.zh, center.zh)
    add('center', center.start_time, center.end_time, center.zl, center.zl)
    return { timeframe, bars, lines }
  }).filter(period => period.bars.length > 0)
}
