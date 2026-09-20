type InstrumentValue = string | number | boolean | null | InstrumentValue[] | { [key: string]: InstrumentValue }
export interface InstrumentSnapshot {
  revision: number
  data: { [key: string]: InstrumentValue }
}
export interface InstrumentSnapshotReader {
  read(accountId: string, symbol: string): Promise<InstrumentSnapshot | null>
}
/** Refresh needs the stored CAS version even when the stored facts are no longer usable. */
export interface InstrumentRevisionReader {
  readRevision(accountId: string, symbol: string): Promise<number>
}
