import type { AccountClock } from '../domain/account-clock.js'

/** Bound to the caller's active transaction; does not acquire or commit one. */
export interface AccountClockReader {
  read(userId: number, accountId: string): Promise<AccountClock | null>
}
