import type { OpenPositionLifecycleInput, OpenPositionLifecycleResult } from '../domain/open-position-lifecycle.js'

export type OpenPositionLifecycleScope = Omit<OpenPositionLifecycleInput, 'deals'> & { accountId: string }

/** Caller authorizes the account and owns a consistent snapshot. MT5 quantity evidence only. */
export interface OpenPositionLifecycleReader {
  read(scope: OpenPositionLifecycleScope): Promise<OpenPositionLifecycleResult>
}
