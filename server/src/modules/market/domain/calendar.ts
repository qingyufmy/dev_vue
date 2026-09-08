export type CalendarImportance = 'low' | 'medium' | 'high' | 'unknown'
export interface CalendarEvent {
  id: string; provider_event_id: string | null; country: string; currency: string | null; title: string
  scheduled_at: string; time_precision: 'exact' | 'date_only' | 'tentative'; importance: CalendarImportance
  period: string | null; unit: string | null; previous: string | null; consensus: string | null
  actual: string | null; revised_previous: string | null
  status: 'scheduled' | 'released' | 'revised' | 'delayed' | 'cancelled'
  provider_updated_at: string | null; revision: string
}
export class MarketReadError extends Error {
  constructor(readonly code: string, readonly status: 400 | 404 | 503) { super(code) }
}
