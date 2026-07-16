import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

describe('Python Bridge history contract', () => {
  it('reads the profile account creation time and both expiry field styles', () => {
    const source = readFileSync(new URL('../public/ai/aurum_bridge_gui.py', import.meta.url), 'utf8')
    expect(source).toContain('userData.get("planExpiresAt") or userData.get("plan_expires_at", "")')
    expect(source).toContain('userData.get("accountCreatedAt")')
    expect(source).toContain('self.account_created_at =')
  })

  it('treats an empty date filter as full account history', () => {
    const source = readFileSync(new URL('../public/ai/aurum_bridge_gui.py', import.meta.url), 'utf8')
    const historyStart = source.indexOf('elif action == "history"')
    const chartStart = source.indexOf('elif action == "chart_data"', historyStart)
    const block = source.slice(historyStart, chartStart)
    expect(source).toContain('FULL_HISTORY_START = datetime(2000, 1, 1)')
    expect(block).toContain('date_from = FULL_HISTORY_START')
    expect(block).not.toContain('else: date_from = date_to - timedelta(days=31)')
  })

  it('uses the same full-history default for chart totals', () => {
    const source = readFileSync(new URL('../public/ai/aurum_bridge_gui.py', import.meta.url), 'utf8')
    const chartStart = source.indexOf('elif action == "chart_data"')
    const block = source.slice(chartStart)
    expect(block).toContain('date_from = FULL_HISTORY_START')
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

  it('enforces the server trade switch and broker volume constraints before opening exposure', () => {
    const source = readFileSync(new URL('../public/ai/aurum_bridge_gui.py', import.meta.url), 'utf8')
    expect(source).toContain('def _validate_order_volume(info, volume):')
    expect(source).toContain('if not self._trade_enabled:')
    expect(source).toContain('volume_error = self._validate_order_volume(info, volume)')
    expect(source).toContain('volume {volume} exceeds broker maximum')
    expect(source).toContain('volume {volume} does not match broker step')
  })

  it('serializes command and publisher access to the non-thread-safe MT5 extension', () => {
    const source = readFileSync(new URL('../public/ai/aurum_bridge_gui.py', import.meta.url), 'utf8')
    expect(source).toContain('self._mt5_lock = threading.RLock()')
    expect(source).toContain('with self._mt5_lock:')
    expect(source).toContain('return self._process_command_locked(cmd)')
    expect(source).toContain('return self._collect_mt5_data_locked()')
  })

  it('rejects invalid pending expirations and reports MT5 pending-list failures', () => {
    const source = readFileSync(new URL('../public/ai/aurum_bridge_gui.py', import.meta.url), 'utf8')
    expect(source).toContain('"message": "invalid pending order expiration"')
    expect(source).toContain('"message": f"orders_get failed: {self.mt5.last_error()}"')
    expect(source).not.toContain('except:')
  })
})
