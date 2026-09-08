/** Published authentication capability; session records and credentials remain owned by auth. */
export interface BrowserRequestAccess {
  authenticate(request: { headers: Record<string, unknown> }): Promise<{ userId: number; role: string }>
  assertWrite(request: { headers: Record<string, unknown> }): Promise<{ userId: number; role: string }>
}
