export interface AccountRegistrationInput {
  platform: 'mt4' | 'mt5'
  brokerServer: string
  login: string
  currency: string
  registeredAt: string
}

export type AccountRegistrationFailure = { ok: false; reason: 'storage_unavailable' | 'storage_invalid' }

/** Bound to an existing transaction; the caller owns its lifetime and commit. */
export interface AccountRegistration {
  createAccount(input: AccountRegistrationInput): Promise<{ ok: true; accountId: string } | AccountRegistrationFailure>
  grantFirstOwnership(input: { userId: number; accountId: string; registeredAt: string }): Promise<{ ok: true } | AccountRegistrationFailure>
}
