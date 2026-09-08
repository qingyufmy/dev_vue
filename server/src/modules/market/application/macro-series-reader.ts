export interface MacroSeriesQuery {
  code: string
  asOf: string
  accessAt: string
  from?: string
  to?: string
  after?: string
  limit: number
}

export interface MacroSeriesObservation {
  code: string
  observationAt: string
  availableAt: string
  value: string | null
  unit: string | null
  valueKind: 'decimal' | 'text'
  calendar: string
  freshnessLimitSeconds: number
  status: 'enabled' | 'disabled' | 'retired'
}

export interface MacroSeriesReader {
  list(query: MacroSeriesQuery): Promise<MacroSeriesObservation[]>
}
