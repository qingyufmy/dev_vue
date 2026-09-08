import type { CalendarEvent, CalendarImportance } from '../domain/calendar.js'

export interface CalendarPageQuery {
  from: string; to: string; importance?: CalendarImportance; limit: number
  after?: { scheduledAt: string; id: string }
}
export interface CalendarReader {
  list(query: CalendarPageQuery, now: string): Promise<CalendarEvent[]>
  find(id: string, now: string): Promise<CalendarEvent | null>
}
