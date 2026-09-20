export interface InstrumentCollectionRequester {
  request(input: { userId: number; accountId: string; symbol: string }): Promise<{ requestId: string; created: boolean }>
}
