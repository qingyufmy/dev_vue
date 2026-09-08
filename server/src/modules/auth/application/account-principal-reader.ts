/** Server-side identity facts only; callers own the snapshot/transaction and authorization policy. */
export interface AccountPrincipalFacts {
  readonly userId: number
  readonly plan: string
  readonly planExpiresAtUtc: string | null
  readonly tokenVersion: number
}

export interface AccountPrincipalReader {
  /** At most 101 IDs (one viewer plus a page of operators). Absent/inactive users are omitted.
   * share requires the caller's open transaction; this capability never commits or releases it.
   * none must use the same consistent snapshot as the other facts in an authorization decision.
   */
  readMany(userIds: readonly number[], lock: 'none' | 'share'): Promise<ReadonlyMap<number, AccountPrincipalFacts>>
}
