import { PrincipalTransactionAbortedError } from '../application/principal-transaction-aborted.js'

export function principalStorageError(error: unknown): Error {
  if (error instanceof Error && 'code' in error && error.code === 'ER_LOCK_DEADLOCK') {
    return new PrincipalTransactionAbortedError()
  }
  // Timeouts, broken connections and malformed facts do not prove transaction abort.
  return Error('auth_principal_unavailable')
}
