import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

describe('Python Bridge history contract', () => {
  it('treats an empty date filter as full account history', () => {
    const source = readFileSync(new URL('../public/ai/aurum_bridge_gui.py', import.meta.url), 'utf8')
    const historyStart = source.indexOf('elif action == "history"')
    const chartStart = source.indexOf('elif action == "chart_data"', historyStart)
    const block = source.slice(historyStart, chartStart)
    expect(block).toContain('date_from = datetime(1970, 1, 1)')
    expect(block).not.toContain('else: date_from = date_to - timedelta(days=31)')
  })

  it('uses the same full-history default for chart totals', () => {
    const source = readFileSync(new URL('../public/ai/aurum_bridge_gui.py', import.meta.url), 'utf8')
    const chartStart = source.indexOf('elif action == "chart_data"')
    const block = source.slice(chartStart)
    expect(block).toContain('date_from = datetime(1970, 1, 1)')
    expect(block).not.toContain('date_from = date_to - timedelta(days=31)')
  })

  it('includes trading fees in history net profit and account statistics', () => {
    const source = readFileSync(new URL('../public/ai/aurum_bridge_gui.py', import.meta.url), 'utf8')
    const historyStart = source.indexOf('elif action == "history"')
    const chartStart = source.indexOf('elif action == "chart_data"', historyStart)
    const block = source.slice(historyStart, chartStart)
    expect(block).toContain('"fee": d.get("fee")')
    expect(block).toContain('"net_profit": float(d.get("profit") or 0) + float(d.get("swap") or 0) + float(d.get("commission") or 0) + float(d.get("fee") or 0)')
    expect(block).toContain('tp = sum(float(r.get("net_profit") or 0) for r in rows)')
  })

  it('exports raw MT5 attribution fields only when explicitly requested', () => {
    const source = readFileSync(new URL('../public/ai/aurum_bridge_gui.py', import.meta.url), 'utf8')
    const historyStart = source.indexOf('elif action == "history"')
    const chartStart = source.indexOf('elif action == "chart_data"', historyStart)
    const block = source.slice(historyStart, chartStart)
    expect(block).toContain('params.get("include_deals", False)')
    for (const field of ['"position_id"', '"deal_ticket"', '"entry"', '"magic"', '"reason"', '"commission"', '"swap"', '"fee"']) {
      expect(block).toContain(field)
    }
  })
})
