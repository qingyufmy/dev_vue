import {
  macroSnapshotResponseSchema, macroSnapshotsResponseSchema, macroSeriesResponseSchema,
  economicCalendarEventsResponseSchema, economicCalendarEventResponseSchema, macroMarketOverviewResponseSchema,
} from '@aurum/contracts'
import type { ZodType } from 'zod'

type Read = <T>(schema: ZodType<T>, path: string, init: { cache: 'no-store'; signal?: AbortSignal }) => Promise<T>
interface Page { limit?: number; cursor?: string }
export interface MarketSeriesQuery extends Page { code: string; from?: string; to?: string }
export interface MarketCalendarQuery extends Page { from: string; to: string; importance?: 'low' | 'medium' | 'high' | 'unknown' }

function query(values: object) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) if (value !== undefined) params.set(key, String(value))
  const result = params.toString()
  return result ? `?${result}` : ''
}

/** Stateless platform market reads; no account store, subscriptions or browser cache. */
export function createMarketClient(read: Read) {
  const options = (signal?: AbortSignal) => ({ cache: 'no-store' as const, ...(signal ? { signal } : {}) })
  return {
    listMacroSnapshots: (page: Page = {}, signal?: AbortSignal) =>
      read(macroSnapshotsResponseSchema, '/api/v4/market/macro-snapshots' + query(page), options(signal)),
    getMacroSnapshot: (id: string, signal?: AbortSignal) =>
      read(macroSnapshotResponseSchema, '/api/v4/market/macro-snapshots/' + encodeURIComponent(id), options(signal)),
    getLatestMacroSnapshot: (signal?: AbortSignal) =>
      read(macroSnapshotResponseSchema, '/api/v4/market/macro-snapshots/latest', options(signal)),
    listMacroSeriesPoints: (input: MarketSeriesQuery, signal?: AbortSignal) =>
      read(macroSeriesResponseSchema, '/api/v4/market/macro-series' + query(input), options(signal)),
    listEconomicCalendarEvents: (input: MarketCalendarQuery, signal?: AbortSignal) =>
      read(economicCalendarEventsResponseSchema, '/api/v4/market/calendar-events' + query(input), options(signal)),
    getEconomicCalendarEvent: (id: string, signal?: AbortSignal) =>
      read(economicCalendarEventResponseSchema, '/api/v4/market/calendar-events/' + encodeURIComponent(id), options(signal)),
    getMacroMarketOverview: (signal?: AbortSignal) =>
      read(macroMarketOverviewResponseSchema, '/api/v4/market/overview', options(signal)),
  }
}
