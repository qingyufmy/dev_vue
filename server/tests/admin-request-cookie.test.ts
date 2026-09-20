import { expect, it, vi } from 'vitest'
import { AuthObserverAdminAdapter } from '../src/modules/auth/transport/http/admin-request-access.js'
import type { AuthService } from '../src/modules/auth/application/auth-service.js'

it('uses the configured admin cookie name without accepting trade or insecure cookies in production', async () => {
  const resolveSession = vi.fn(async (raw: string | undefined) => { if (!raw) throw Error('missing'); return { user: { id: 1, role: 'admin' }, session: {} } })
  const service = { cookieName: () => '__Host-aurum_admin-web_session', resolveSession, assertCsrf: vi.fn() } as unknown as AuthService
  const local = new AuthObserverAdminAdapter(service, false)
  await local.authenticate({ headers: { cookie: 'aurum_dev_admin-web_session=admin-local' } })
  expect(resolveSession).toHaveBeenLastCalledWith('admin-local', 'admin-web')
  const production = new AuthObserverAdminAdapter(service)
  await expect(production.authenticate({ headers: { cookie: 'aurum_dev_admin-web_session=admin-local; aurum_dev_trade-web_session=trade' } })).rejects.toThrow()
  await production.authenticate({ headers: { cookie: '__Host-aurum_admin-web_session=admin-secure' } })
  expect(resolveSession).toHaveBeenLastCalledWith('admin-secure', 'admin-web')
})
