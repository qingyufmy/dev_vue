/** Bound to the caller's transaction; never begins, commits or releases it. */
export interface ActivePrincipalAccess {
  isActive(userId: number, lock: 'none' | 'update'): Promise<boolean>
}
