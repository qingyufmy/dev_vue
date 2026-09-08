import type { PoolConnection } from 'mysql2/promise'
import { expect, it, vi } from 'vitest'
import { createActivePrincipalAccess, createAdminPrincipalAccess, createAccountPrincipalReader } from '../src/modules/auth/composition.js'
import { PrincipalTransactionAbortedError } from '../src/modules/auth/index.js'

const readers = [
  ['active', (connection: PoolConnection) => createActivePrincipalAccess(connection).isActive(7, 'update')],
  ['admin', (connection: PoolConnection) => createAdminPrincipalAccess(connection).isAdmin(7, 'share')],
  ['facts', (connection: PoolConnection) => createAccountPrincipalReader(connection).readMany([7], 'share')],
] as const

it.each(readers)('%s exposes a sanitized definitive abort through the public auth contract', async (_name, read) => {
  const execute = vi.fn().mockRejectedValue(Object.assign(Error('private SQL and credentials'), { code: 'ER_LOCK_DEADLOCK' }))
  const error = await read({ execute } as unknown as PoolConnection).catch(error => error)
  expect(error).toBeInstanceOf(PrincipalTransactionAbortedError)
  expect(error.message).toBe('auth_principal_transaction_aborted')
  expect(error.cause).toBeUndefined()
  expect(error.code).toBeUndefined()
  expect(execute).toHaveBeenCalledOnce()
})

it.each(readers)('%s never treats timeout, disconnect or message text as a confirmed abort', async (_name, read) => {
  for (const failure of [Object.assign(Error('timeout'), { code: 'ER_LOCK_WAIT_TIMEOUT' }),
    Object.assign(Error('disconnect'), { code: 'PROTOCOL_CONNECTION_LOST' }), Error('ER_LOCK_DEADLOCK')]) {
    const execute = vi.fn().mockRejectedValue(failure)
    const error = await read({ execute } as unknown as PoolConnection).catch(error => error)
    expect(error).not.toBeInstanceOf(PrincipalTransactionAbortedError)
    expect(error.message).toBe('auth_principal_unavailable')
    expect(execute).toHaveBeenCalledOnce()
  }
})
