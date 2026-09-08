/** The owning transaction was definitively aborted by storage concurrency control.
 * The caller must complete cleanup before considering a bounded, full-use-case retry.
 * This is never a statement retry, permission grant, or commit-outcome classification.
 */
export class PrincipalTransactionAbortedError extends Error {
  constructor() { super('auth_principal_transaction_aborted') }
}
