import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { AuthError } from '../src/modules/auth/domain/auth.js'
import { ReferralRuleManagementService } from '../src/modules/commerce/application/referral-rule-management.js'
import { referralRuleRoutes } from '../src/modules/commerce/transport/http/referral-rule-routes.js'
import { exactAdminHostHook } from '../src/transport/api-v4-route-registrar.js'
const body = { changes: [{ rule_id: '2', expected_revision: '9007199254740993', rate_bps: 0, enabled: false }] }
async function fixture() {
  const execute = vi.fn().mockResolvedValue({ rules: [{ id: 2, revision: '9007199254740994' }], replayed: false })
  const list = vi.fn().mockResolvedValue([{ id: '2', plan: 'plus', period: 'monthly', rateBps: 0, enabled: false, revision: '9007199254740993' }])
  const auth = { authenticate: vi.fn().mockResolvedValue({ userId: 1, role: 'admin' }), assertWrite: vi.fn().mockResolvedValue({ userId: 1, role: 'admin' }) }
  const app = Fastify()
  app.addHook('onRequest', exactAdminHostHook('https://admin.example.test'))
  await app.register(referralRuleRoutes, { prefix: '/api/v4/admin/referrals', service: new ReferralRuleManagementService({ execute, list }), auth })
  const send = (payload: unknown = body, headers = {}, suffix = '') => app.inject({ method: 'PUT', url: '/api/v4/admin/referrals/rules' + suffix,
    headers: { host: 'admin.example.test', 'x-csrf-token': 'csrf-token-1234567890', 'idempotency-key': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', ...headers }, payload: payload as object })
  return { app, send, execute, list, auth }
}
describe('admin referral rules HTTP boundary', () => {
  it('rejects undeclared queries and malformed headers before writes, after authentication', async () => {
    const f = await fixture()
    try {
      f.auth.assertWrite.mockRejectedValueOnce(new AuthError('auth_session_invalid', 401))
      expect((await f.send(body, {}, '?actor=2')).statusCode).toBe(401)
      for (const r of [await f.send(body, {}, '?actor=2'), await f.send(body, { 'x-csrf-token': 'short' })]) {
        expect(r.statusCode).toBe(400)
        expect(r.headers['cache-control']).toBe('no-store')
        expect(r.headers['content-type']).toContain('application/problem+json')
      }
      expect(f.execute).not.toHaveBeenCalled()
    } finally { await f.app.close() }
  })
  it('rejects malformed read output and keeps post-commit output failure uncertain', async () => {
    const f = await fixture()
    try {
      f.list.mockResolvedValueOnce([{ id: '2', plan: 'internal-secret' }])
      const read = await f.app.inject({ url: '/api/v4/admin/referrals/rules', headers: { host: 'admin.example.test' } })
      expect(read.statusCode).toBe(503)
      expect(read.body).not.toContain('internal-secret')
      expect(read.headers['cache-control']).toBe('no-store')
      f.execute.mockResolvedValueOnce({ rules: [{ id: 2, revision: { secret: 'internal-secret' } }], replayed: false })
      const write = await f.send()
      expect(write.statusCode).toBe(503)
      expect(write.json().code).toBe('referral_rule_commit_unknown')
      expect(write.body).not.toContain('internal-secret')
      expect(f.execute).toHaveBeenCalledOnce()
      expect(write.headers['cache-control']).toBe('no-store')
    } finally { await f.app.close() }
  })
  it('reads canonical rules without caching or invoking write authentication', async () => {
    const f = await fixture()
    try {
      const reply = await f.app.inject({ method: 'GET', url: '/api/v4/admin/referrals/rules', headers: { host: 'admin.example.test' } })
      expect(reply.statusCode).toBe(200)
      expect(reply.headers['cache-control']).toBe('no-store')
      expect(reply.json().data.rules[0]).toEqual({ rule_id: '2', plan: 'plus', period: 'monthly', rate_bps: 0, enabled: false, revision: '9007199254740993' })
      expect(f.list).toHaveBeenCalledWith(1)
      expect(f.auth.assertWrite).not.toHaveBeenCalled()
      expect(f.execute).not.toHaveBeenCalled()
    } finally { await f.app.close() }
  })

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
