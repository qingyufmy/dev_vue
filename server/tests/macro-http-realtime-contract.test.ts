import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('M1 machine-readable macro contracts', () => {
  it('publishes the frozen user HTTP paths and bounded response schemas', async () => {
    const openapi = JSON.parse(await readFile(new URL('../../contracts/openapi-v4.json', import.meta.url), 'utf8'))
    expect(openapi.paths['/market/overview'].get.operationId).toBe('getMacroMarketOverview')
    expect(openapi.paths['/market/macro-snapshots/latest'].get.operationId).toBe('getLatestMacroSnapshot')
    expect(openapi.paths['/market/macro-snapshots'].get.operationId).toBe('listMacroSnapshots')
    expect(openapi.paths['/market/macro-snapshots/{snapshot_id}'].get.operationId).toBe('getMacroSnapshot')
    expect(openapi.paths['/market/macro-series'].get.operationId).toBe('listMacroSeriesPoints')
    expect(openapi.paths['/market/calendar-events'].get.operationId).toBe('listEconomicCalendarEvents')
    expect(openapi.paths['/market/calendar-events/{event_id}'].get.operationId).toBe('getEconomicCalendarEvent')
    expect(openapi.components.schemas.MacroSnapshotSummary.properties).not.toHaveProperty('factors')
    expect(openapi.components.schemas.MacroMarketOverviewResponse.properties.data.properties.high_impact_events.maxItems).toBe(20)
  })

  it('publishes strict changed events and keeps source health on the admin target', async () => {
    const realtime = JSON.parse(await readFile(new URL('../../contracts/realtime-v4.schema.json', import.meta.url), 'utf8'))
    expect(realtime.$defs.ServerEventType.enum).toEqual(expect.arrayContaining([
      'market.macro.changed', 'market.calendar.changed', 'market.source_health.changed',
    ]))
    expect(realtime.$defs.MacroChangedData).toMatchObject({
      additionalProperties: false,
      required: ['change', 'published_at', 'status'],
    })
    expect(realtime.$defs.CalendarChangedData).toMatchObject({
      additionalProperties: false,
      required: ['change', 'scheduled_at', 'importance', 'status'],
    })
    const targetRules = realtime.$defs.SubscriptionTarget.allOf as Array<Record<string, unknown>>
    expect(JSON.stringify(targetRules)).toContain('macro_source_health')
    expect(JSON.stringify(targetRules)).toContain('"macro","calendar"')
  })
})
