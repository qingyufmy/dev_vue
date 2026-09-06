import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { AuthError } from '../src/modules/auth/domain/auth.js'
import { ReferralRuleManagementService } from '../src/modules/commerce/application/referral-rule-management.js'
import { referralRuleRoutes } from '../src/modules/commerce/transport/http/referral-rule-routes.js'
import { exactAdminHostHook } from '../src/transport/api-v4-route-registrar.js'
const body = { changes: [{ rule_id: '2', expected_revision: '9007199254740993', rate_bps: 0, enabled: false }] }
async function fixture() {
  const execute = vi.fn().mockResolvedValue({ rules: [{ id: 2, revision: '9007199254740994' }], replayed: false })
  const auth = { assertWrite: vi.fn().mockResolvedValue({ userId: 1, role: 'admin' }) }
  const app = Fastify()
  app.addHook('onRequest', exactAdminHostHook('https://admin.example.test'))
  await app.register(referralRuleRoutes, { prefix: '/api/v4/admin/referrals', service: new ReferralRuleManagementService({ execute }), auth })
  const send = (payload: unknown = body, headers = {}) => app.inject({ method: 'PUT', url: '/api/v4/admin/referrals/rules',
    headers: { host: 'admin.example.test', 'idempotency-key': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ...headers }, payload: payload as object })
  return { app, send, execute, auth }
}
describe('admin referral rules HTTP boundary', () => {
  it('preserves string revisions and maps the verified actor rather than a body user ID', async () => {
    const f = await fixture()
    try {
      const reply = await f.send()
      expect(reply.statusCode).toBe(200)
      expect(reply.json().data.rules[0].revision).toBe('9007199254740994')
      expect(f.execute.mock.calls[0]![0]).toMatchObject({ actorUserId: 1, changes: [{ id: 2, expectedRevision: '9007199254740993', rateBps: 0, enabled: false }] })
      expect(f.auth.assertWrite).toHaveBeenCalledOnce()
    } finally { await f.app.close() }
  })
  it('blocks wrong host, CSRF failure, and non-administrators before repository writes', async () => {
    const f = await fixture()
    try {
      expect((await f.send(body, { host: 'trade.example.test' })).statusCode).toBe(421)
      f.auth.assertWrite.mockRejectedValueOnce(new AuthError('csrf_invalid', 403))
      expect((await f.send()).statusCode).toBe(403)
      f.auth.assertWrite.mockResolvedValueOnce({ userId: 1, role: 'user' })
      expect((await f.send()).statusCode).toBe(403)
      expect(f.execute).not.toHaveBeenCalled()
    } finally { await f.app.close() }
  })
  it('rejects unknown fields and coerced booleans or revisions', async () => {
    const f = await fixture()
    try {
      for (const payload of [{ ...body, actor_user_id: 2 }, { changes: [{ ...body.changes[0], enabled: 'false' }] },
        { changes: [{ ...body.changes[0], expected_revision: 1 }] }]) expect((await f.send(payload)).statusCode).toBe(400)
      expect(f.execute).not.toHaveBeenCalled()
    } finally { await f.app.close() }
  })
  it('returns safe problems for conflicts and unknown commits without leaking SQL', async () => {
    const f = await fixture()
    try {
      f.execute.mockRejectedValueOnce(Error('referral_rule_idempotency_conflict'))
      expect((await f.send()).statusCode).toBe(409)
      f.execute.mockRejectedValueOnce(Error('referral_rule_commit_unknown'))
      expect((await f.send()).json().code).toBe('referral_rule_commit_unknown')
      f.execute.mockRejectedValueOnce(Error('SELECT secret_password FROM secret_table'))
      const reply = await f.send()
      expect(reply.statusCode).toBe(503)
      expect(reply.body).not.toContain('secret_')
    } finally { await f.app.close() }
  })
})
