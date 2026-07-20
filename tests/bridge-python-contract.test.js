import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

describe('Python Bridge history contract', () => {
  it('provides a compact incremental risk snapshot without full-history export', () => {
    const source = readFileSync(new URL('../public/ai/aurum_bridge_gui.py', import.meta.url), 'utf8')
    const start = source.indexOf('def _risk_snapshot')
    const end = source.indexOf('def _process_command', start)
    const block = source.slice(start, end)
    expect(block).toContain('history_deals_get(date_from, date_to)')
    expect(block).toContain('history_deals_get(position=position_id)')
    expect(block).toContain('requested_cursor')
    expect(block).toContain('closed_positions')
    expect(block).toContain('account_events')
    expect(block).toContain('order_calc_profit')
    expect(block).toContain('order_calc_margin')
    expect(block).not.toContain('FULL_HISTORY_START')
  })
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

  it('reuses one deal range and only reads order details for the visible page', () => {
    const source = readFileSync(new URL('../public/ai/aurum_bridge_gui.py', import.meta.url), 'utf8')
    expect(source).toContain('def _history_deals_for_range(self, date_from, date_to, force_refresh=False):')
    expect(source).toContain('age <= 15.0 and (not force_refresh or age <= 1.0)')
    const historyStart = source.indexOf('elif action == "history"')
    const chartStart = source.indexOf('elif action == "chart_data"', historyStart)
    const block = source.slice(historyStart, chartStart)
    expect(block).toContain('orders = self.mt5.history_orders_get(date_from, date_to) if include_deals else None')
    expect(block).toContain('for row in pr:')
    expect(block).toContain('history_orders_get(ticket=int(row.get("ticket") or 0))')
  })

  it('uses fee-inclusive net profit in chart aggregation', () => {
    const source = readFileSync(new URL('../public/ai/aurum_bridge_gui.py', import.meta.url), 'utf8')
    const chartStart = source.indexOf('elif action == "chart_data"')
    const block = source.slice(chartStart)
    expect(block).toContain('float(d.get("commission") or 0) + float(d.get("fee") or 0)')
    expect(block).toContain('"history_cache_hit": history_cache_hit')
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

  it('never treats a non-DONE MT5 ticket as confirmed execution', () => {
    const source = readFileSync(new URL('../public/ai/aurum_bridge_gui.py', import.meta.url), 'utf8')
    expect(source).toContain('classification = classify_deal_result(result, self.mt5)')
    expect(source).toContain('"status": "uncertain"')
    expect(source).toContain('remaining = self.mt5.positions_get(ticket=pos.ticket)')
    expect(source).not.toContain('订单已成交但返回码非DONE')
  })

  it('serializes command and publisher access to the non-thread-safe MT5 extension', () => {
    const source = readFileSync(new URL('../public/ai/aurum_bridge_gui.py', import.meta.url), 'utf8')
    expect(source).toContain('self._mt5_lock = threading.RLock()')
    expect(source).toContain('with self._mt5_lock:')
    expect(source).toContain('return self._process_command_locked(cmd)')
    expect(source).toContain('return self._collect_mt5_data_locked()')
  })

  it('normalizes broker wall-clock timestamps while retaining the raw MT5 timestamp', () => {
    const source = readFileSync(new URL('../public/ai/aurum_bridge_gui.py', import.meta.url), 'utf8')
    expect(source).toContain('def _calibrate_mt5_clock(self, tick, force=False):')
    expect(source).toContain('DEFAULT_MT5_TIMEZONE_OFFSET_MINUTES = 180')
    expect(source).toContain('if previous_raw_ms == raw_ms:')
    expect(source).toContain('raw_progress_ms = raw_ms - previous_raw_ms')
    expect(source).toContain('abs(raw_progress_ms - host_progress_ms) > MT5_CLOCK_FRESHNESS_TOLERANCE_MS')
    expect(source).toContain('"mt5_timezone_offset_version": 2')
    expect(source).toContain('update_config({"mt5_timezone_offset_minutes": candidate')
    expect(source).toContain('"time_utc_msc": raw_ms - offset * 60000')
    expect(source).toContain('"timezone_offset_minutes": offset')
    expect(source).toContain('"clock_status": self._mt5_clock_status')
  })

  it('detects market state next to MT5 and publishes it in data and heartbeats', () => {
    const source = readFileSync(new URL('../public/ai/aurum_bridge_gui.py', import.meta.url), 'utf8')
    expect(source).toContain('def _detect_market_state(self, symbol, info, tick, terminal_info=None):')
    expect(source).toContain('terminal = self.mt5.terminal_info()')
    expect(source).toContain('info = self.mt5.symbol_info(sym)')
    expect(source).toContain('"market_state_version": 1')
    expect(source).toContain('"market_state": state')
    expect(source).toContain('"symbol_trade_mode": trade_mode')
    expect(source).toContain('"tick_progressing": tick_progressing')
    expect(source).toContain('observation.get("confirmed_open") and unchanged_seconds < 60')
    expect(source).toContain('**(self._last_market_state or {})')
    expect(source).toContain('market_fields = self._detect_market_state(sym, info, tick, terminal)')
    expect(source).toContain('elif action == "market_state":')
    expect(source).toContain('self._detect_market_state(symbol, info, tick, terminal)')
  })

  it('rejects invalid pending expirations and reports MT5 pending-list failures', () => {
    const source = readFileSync(new URL('../public/ai/aurum_bridge_gui.py', import.meta.url), 'utf8')
    expect(source).toContain('"message": "invalid pending order expiration"')
    expect(source).toContain('"message": f"orders_get failed: {self.mt5.last_error()}"')
    expect(source).not.toContain('except:')
  })

  it('prechecks stop-limit orders and uses the official MT5 request field', () => {
    const source = readFileSync(new URL('../public/ai/aurum_bridge_gui.py', import.meta.url), 'utf8')
    const pendingStart = source.indexOf('elif action == "pending"')
    const cancelStart = source.indexOf('elif action == "cancel_pending"', pendingStart)
    const block = source.slice(pendingStart, cancelStart)
    expect(block).toContain('req["stoplimit"] = float(stoplimit_price)')
    expect(block).toContain('check = self.mt5.order_check(req)')
    expect(block).toContain('"status": "rejected"')
    expect(block).toContain('"retcode": result.retcode')
  })

  it('exposes lightweight symbol metadata for account simulation without exporting history', () => {
    const source = readFileSync(new URL('../public/ai/aurum_bridge_gui.py', import.meta.url), 'utf8')
    const start = source.indexOf('elif action == "symbol_snapshot":')
    const end = source.indexOf('elif action == "order_lookup":', start)
    const block = source.slice(start, end)
    expect(block).toContain('self.mt5.symbol_info(symbol)')
    expect(block).toContain('"tick_value":')
    expect(block).toContain('"contract_size":')
    expect(block).toContain('"margin_initial":')
    expect(block).toContain('"currency_margin":')
    expect(block).toContain('"leverage":')
    expect(block).toContain('"margin_mode":')
    expect(block).toContain('"margin_so_mode":')
    expect(block).toContain('"margin_so_so":')
    expect(block).not.toContain('history_deals_get')
    expect(block).not.toContain('positions_get')
    expect(block).not.toContain('orders_get')
  })
})
