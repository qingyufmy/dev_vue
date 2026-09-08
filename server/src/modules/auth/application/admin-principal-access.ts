/** Current active administrator identity; the caller owns any transaction. */
export interface AdminPrincipalAccess {
  /** share requires the caller's transaction; no locks survive an autocommit read. */
  isAdmin(userId: number, lock: 'none' | 'share'): Promise<boolean>
}
