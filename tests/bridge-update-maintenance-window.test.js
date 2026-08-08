import { describe, expect, it, vi } from 'vitest'

import {
  createBridgeAutomaticMaintenanceWindowGate,
  resolveBridgeUpdateMaintenanceWindows,
} from '../server/bridge-v3/update-maintenance-window.js'

function terminal(overrides = {}) {
  return {
    user_id:7,
    terminal_instance_id:'terminal_01JWINDOW0001',
    platform:'mt5',
    account_ref:{ broker_server:'DooTechnology-Demo', login:'596520' },
    ...overrides,
  }
}

function closedSample(overrides = {}) {
  return {
    status:'success',
    terminal_connected:true,
    market_state:'stale',
    tick_age_seconds:121,
    tick_unchanged_seconds:null,
    timezone_offset_minutes:180,
    clock_status:'calibrated',
    ...overrides,
  }
}

const configuredWindows = resolveBridgeUpdateMaintenanceWindows(JSON.stringify([{
  platform:'mt5',
  broker_server:'DooTechnology-Demo',
  timezone_offset_minutes:180,
  start:'23:58',
  end:'00:12',
  probe_symbol:'XAUUSD',
}]))

function createGate({
  windows = configuredWindows,
  now = () => Date.parse('2026-07-27T21:00:00Z'),
  terminals = [terminal()],
  sample = closedSample(),
} = {}) {
  const resolveTerminals = vi.fn().mockResolvedValue(terminals)
  const probeMarket = vi.fn().mockResolvedValue(sample)
  return {
    resolveTerminals,
    probeMarket,
    gate:createBridgeAutomaticMaintenanceWindowGate({
      windows, now, resolveTerminals, probeMarket,
    }),
  }
}

function request(overrides = {}) {
  return {
    priority:'normal',
    manualRequest:false,
    authorizedUserIds:[7],
    terminalInstanceIds:['terminal_01JWINDOW0001'],
    ...overrides,
  }
}

describe('bridge automatic maintenance window', () => {
  it('rejects malformed, ambiguous, or duplicate Broker window configuration', () => {
    expect(() => resolveBridgeUpdateMaintenanceWindows('{')).toThrow(
      'bridge_maintenance_window_configuration_invalid')
    expect(() => resolveBridgeUpdateMaintenanceWindows(JSON.stringify([{
      platform:'mt5', broker_server:'Demo', timezone_offset_minutes:180,
      start:'24:00', end:'00:10', probe_symbol:'XAUUSD',
    }]))).toThrow('bridge_maintenance_window_configuration_invalid')
    expect(() => resolveBridgeUpdateMaintenanceWindows(JSON.stringify([
      { platform:'mt5', broker_server:'Demo', timezone_offset_minutes:180,
        start:'23:50', end:'00:10', probe_symbol:'XAUUSD' },
      { platform:'mt5', broker_server:'demo', timezone_offset_minutes:180,
        start:'23:55', end:'00:15', probe_symbol:'XAUUSD' },
    ]))).toThrow('bridge_maintenance_window_configuration_invalid')
  })

  it('admits a weekday normal update only inside the exact Broker window with stopped quotes', async () => {
    const { gate, resolveTerminals, probeMarket } = createGate()

    await expect(gate(request())).resolves.toMatchObject({
      allowed:true, mode:'daily_maintenance',
    })
    expect(resolveTerminals).toHaveBeenCalledWith([7], ['terminal_01JWINDOW0001'])
    expect(probeMarket).toHaveBeenCalledWith(expect.objectContaining({
      terminal_instance_id:'terminal_01JWINDOW0001',
    }), 'XAUUSD')
  })

  it('fails closed on weekdays without a configured Broker window', async () => {
    const { gate, probeMarket } = createGate({ windows:[] })

    await expect(gate(request())).resolves.toMatchObject({
      allowed:false,
      code:'bridge_maintenance_window_unconfigured',
      retry_after_seconds:900,
    })
    expect(probeMarket).not.toHaveBeenCalled()
  })

  it('requires at least three minutes left and 90 seconds without quotes', async () => {
    const tooLate = createGate({ now:() => Date.parse('2026-07-27T21:10:30Z') })
    await expect(tooLate.gate(request())).resolves.toMatchObject({
      allowed:false, code:'bridge_maintenance_window_too_short',
    })
    const stillTrading = createGate({ sample:closedSample({ market_state:'open', tick_age_seconds:1 }) })
    await expect(stillTrading.gate(request())).resolves.toMatchObject({
      allowed:false, code:'bridge_maintenance_market_not_closed',
    })
    const wrongClock = createGate({ sample:closedSample({ timezone_offset_minutes:120 }) })
    await expect(wrongClock.gate(request())).resolves.toMatchObject({
      allowed:false, code:'bridge_maintenance_terminal_clock_unavailable',
    })
  })

  it('allows a closed weekend without requiring Broker window configuration', async () => {
    const { gate } = createGate({
      windows:[],
      now:() => Date.parse('2026-08-01T12:00:00Z'),
    })
    await expect(gate(request())).resolves.toMatchObject({
      allowed:true, mode:'weekend_closed',
    })
  })

  it('lets urgent and explicit manual updates proceed to the existing lease and drain gates', async () => {
    const { gate, resolveTerminals, probeMarket } = createGate({ windows:[] })
    await expect(gate(request({ priority:'urgent' }))).resolves.toMatchObject({
      allowed:true, mode:'safe_idle',
    })
    await expect(gate(request({ manualRequest:true }))).resolves.toMatchObject({
      allowed:true, mode:'safe_idle',
    })
    expect(resolveTerminals).not.toHaveBeenCalled()
    expect(probeMarket).not.toHaveBeenCalled()
  })
})
