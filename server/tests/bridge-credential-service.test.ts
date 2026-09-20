import { bridgeCredentialRoutes } from '../src/modules/bridge/transport/http/bridge-credential-routes.js'
import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import {
  BridgeCredentialError,
  BridgeCredentialService,
} from '../src/modules/bridge/index.js'
import type {
  BridgeCredentialRepository,
  BridgeSessionTicketClaims,
  BridgeSessionTicketIssuer,
  DeviceRefreshSession,
  RotateLegacyCredentialInput,
  RotatedBridgeCredential,
  UseDeviceRefreshInput,
} from '../src/modules/bridge/index.js'

const legacyToken = 'legacy_' + 'a'.repeat(64)
const fingerprint = 'sha256:' + 'b'.repeat(64)

class MemoryRepository implements BridgeCredentialRepository {
  readonly migrations = new Map<string, { userId: number; generation: number; tokenHash: string }>()
  readonly validLegacyHashes = new Set<string>()
  lastRotateInput: RotateLegacyCredentialInput | null = null
  deviceSession: DeviceRefreshSession | null = null
  revoked = false

  async rotateFromLegacy(input: RotateLegacyCredentialInput): Promise<RotatedBridgeCredential> {
    this.lastRotateInput = input
    if (!this.validLegacyHashes.has(input.legacyTokenHash)) {
      throw new BridgeCredentialError('bridge_legacy_credential_invalid', 401)
    }
    if (this.revoked) throw new BridgeCredentialError('bridge_credential_migration_revoked', 409)
    const existing = this.migrations.get(input.migrationKey)
    const next = {
      userId: existing?.userId ?? 7,
      generation: (existing?.generation ?? 0) + 1,
      tokenHash: input.replacementTokenHash,
    }
    this.migrations.set(input.migrationKey, next)
    this.deviceSession = {
      userId: next.userId,
      generation: next.generation,
      installationId: input.installationId,
      profileId: input.profileId,
    }
    return next
  }

  async useDeviceRefresh(input: UseDeviceRefreshInput): Promise<DeviceRefreshSession> {
    if (this.revoked) throw new BridgeCredentialError('bridge_credential_binding_invalid', 401)
    return this.exactDevice(input)
  }

  async revokeDeviceRefresh(input: Pick<UseDeviceRefreshInput, 'tokenHash' | 'installationId' | 'profileId'>): Promise<DeviceRefreshSession> {
    const session = this.exactDevice(input)
    this.revoked = true
    return session
  }

  private exactDevice(input: Pick<UseDeviceRefreshInput, 'tokenHash' | 'installationId' | 'profileId'>) {
    const session = this.deviceSession
    const current = [...this.migrations.values()][0]
    if (!session || !current || current.tokenHash !== input.tokenHash
      || session.installationId !== input.installationId || session.profileId !== input.profileId) {
      throw new BridgeCredentialError('bridge_credential_binding_invalid', 401)
    }
    return session
  }
}

class MemoryTicketIssuer implements BridgeSessionTicketIssuer {
  lastClaims: BridgeSessionTicketClaims | null = null
  async issue(claims: BridgeSessionTicketClaims) {
    this.lastClaims = claims
    return { token: 'bst_' + 'c'.repeat(43), expiresInSeconds: 30 }
  }
}

function createFixture() {
  const repository = new MemoryRepository()
  const tickets = new MemoryTicketIssuer()
  const service = new BridgeCredentialService(repository, tickets)
  return { repository, tickets, service }
}

describe('BridgeCredentialService', () => {
  it('rotates one stable migration row without exposing or revoking the V3 token', async () => {
    const fixture = createFixture()
    const { hashSecret } = await import('../src/modules/bridge/domain/bridge-credential.js')
    fixture.repository.validLegacyHashes.add(hashSecret(legacyToken))
    const input = {
      schemaVersion: 1,
      legacyRefreshToken: legacyToken,
      installationId: 'install-01',
      profileId: 'default',
      sourceFingerprint: fingerprint,
    }
    const first = await fixture.service.exchangeLegacyCredential(input)
    const second = await fixture.service.exchangeLegacyCredential(input)

    expect(first.refresh_token).not.toBe(second.refresh_token)
    expect(first.generation).toBe(1)
    expect(second.generation).toBe(2)
    expect(fixture.repository.migrations).toHaveLength(1)
    expect(fixture.repository.validLegacyHashes).toContain(hashSecret(legacyToken))
    expect(JSON.stringify(fixture.repository.lastRotateInput)).not.toContain(legacyToken)
    expect(second).toMatchObject({
      credential_type: 'bridge_refresh',
      session_token_path: '/api/v4/bridge/session-tokens',
      websocket_path: '/bridge/v4/ws',
    })
  })

  it('binds short session tickets to installation, profile and generation', async () => {
    const fixture = createFixture()
    const { hashSecret } = await import('../src/modules/bridge/domain/bridge-credential.js')
    fixture.repository.validLegacyHashes.add(hashSecret(legacyToken))
    const exchanged = await fixture.service.exchangeLegacyCredential({
      schemaVersion: 1,
      legacyRefreshToken: legacyToken,
      installationId: 'install-01',
      profileId: 'profile-a',
      sourceFingerprint: fingerprint,
    })
    const result = await fixture.service.createSessionToken({
      refreshToken: exchanged.refresh_token,
      installationId: 'install-01',
      profileId: 'profile-a',
    })
    expect(result).toEqual({
      credential_type: 'bridge_session',
      access_token: 'bst_' + 'c'.repeat(43),
      expires_in_seconds: 30,
      websocket_path: '/bridge/v4/ws',
    })
    expect(fixture.tickets.lastClaims).toEqual({
      userId: 7,
      installationId: 'install-01',
      profileId: 'profile-a',
      generation: 1,
    })
  })

  it('fails closed on a revoked migration or mismatched device binding', async () => {
    const fixture = createFixture()
    const { hashSecret } = await import('../src/modules/bridge/domain/bridge-credential.js')
    fixture.repository.validLegacyHashes.add(hashSecret(legacyToken))
    fixture.repository.revoked = true
    await expect(fixture.service.exchangeLegacyCredential({
      schemaVersion: 1,
      legacyRefreshToken: legacyToken,
      installationId: 'install-01',
      profileId: 'default',
      sourceFingerprint: fingerprint,
    })).rejects.toMatchObject({ code: 'bridge_credential_migration_revoked', status: 409 })

    fixture.repository.revoked = false
    const exchanged = await fixture.service.exchangeLegacyCredential({
      schemaVersion: 1,
      legacyRefreshToken: legacyToken,
      installationId: 'install-01',
      profileId: 'default',
      sourceFingerprint: fingerprint,
    })
    await expect(fixture.service.createSessionToken({
      refreshToken: exchanged.refresh_token,
      installationId: 'other-install',
      profileId: 'default',
    })).rejects.toMatchObject({ code: 'bridge_credential_binding_invalid', status: 401 })
  })
})

describe('Bridge credential V4 routes', () => {
  it('rejects unknown or coerced fields on all credential paths before effects and hides invalid results', async () => {
    const fixture = createFixture()
    const app = Fastify()
    await app.register(bridgeCredentialRoutes, { prefix: '/api/v4', service: fixture.service })
    const device = { refresh_token: legacyToken, installation_id: 'install-01', profile_id: 'default' }
    const operations = [
      { path: '/bridge/legacy-credential-exchanges', method: 'exchangeLegacyCredential' as const,
        payload: { schema_version: 1, legacy_refresh_token: legacyToken, installation_id: 'install-01', profile_id: 'default', source_fingerprint: fingerprint } },
      { path: '/bridge/session-tokens', method: 'createSessionToken' as const, payload: device },
      { path: '/bridge/credential-revocations', method: 'revokeDeviceCredential' as const, payload: device },
    ]
    try {
      for (const input of operations) {
        const call = vi.spyOn(fixture.service, input.method)
        const request = { method: 'POST' as const, url: '/api/v4' + input.path, payload: input.payload }
        for (const payload of [{ ...input.payload, user_id: 8 }, { ...input.payload, profile_id: 3 }]) {
          expect((await app.inject({ ...request, payload })).statusCode).toBe(400)
        }
        const query = await app.inject({ ...request, url: request.url + '?token=' + legacyToken })
        expect(query.statusCode).toBe(400)
        expect(query.body).not.toContain(legacyToken)
        expect(call).not.toHaveBeenCalled()
        call.mockResolvedValueOnce({ unexpected_secret: legacyToken } as never)
        const failed = await app.inject(request)
        expect(failed.statusCode).toBe(503)
        expect(failed.json()).toMatchObject({ code: 'bridge_credential_result_unknown', retryable: false })
        expect(failed.headers['content-type']).toContain('application/problem+json')
        expect(failed.headers['cache-control']).toBe('no-store')
        expect(failed.body).not.toContain(legacyToken)
        call.mockRejectedValueOnce(new BridgeCredentialError('bridge_credential_commit_unknown', 503, false))
        const uncertain = await app.inject(request)
        expect(uncertain.statusCode).toBe(503)
        expect(uncertain.json()).toMatchObject({ code: 'bridge_credential_commit_unknown', retryable: false })
        expect(uncertain.body).not.toContain(legacyToken)
        call.mockRestore()
      }
    } finally { await app.close() }
  })

  it('rejects extra fields, coercion, invalid bodies and oversize revocations without reflecting secrets', async () => {
    const fixture = createFixture()
    const app = Fastify({ logger: false })
    await app.register(bridgeCredentialRoutes, { prefix: '/api/v4', service: fixture.service })
    try {
      const valid = { refresh_token: legacyToken, installation_id: 'install-01', profile_id: 'default' }
      for (const payload of [
        { ...valid, user_id: 7 }, { ...valid, profile_id: 3 }, { ...valid, installation_id: 'install-01\n' },
        { ...valid, refresh_token: 'x'.repeat(5000) }, {}, null, [],
      ]) {
        const result = await app.inject({ method: 'POST', url: '/api/v4/bridge/credential-revocations',
          headers: { 'content-type': 'application/json' }, payload: JSON.stringify(payload) })
        expect(result.statusCode).toBe(400)
        expect(result.json()).toMatchObject({ code: 'bridge_credential_request_invalid' })
        expect(result.body).not.toContain(legacyToken)
      }
      const denied = await app.inject({ method: 'POST', url: '/api/v4/bridge/credential-revocations', payload: valid })
      expect(denied.statusCode).toBe(401)
      expect(denied.body).not.toContain(legacyToken)
      fixture.repository.revokeDeviceRefresh = async () => { throw new Error(`database detail ${legacyToken}`) }
      const failure = await app.inject({ method: 'POST', url: '/api/v4/bridge/credential-revocations', payload: valid })
      expect(failure.statusCode).toBe(503)
      expect(failure.body).not.toContain(legacyToken)
      expect(failure.body).not.toContain('database detail')
    } finally { await app.close() }
  })

  it('serializes successful exchange and session-token responses through the route schemas', async () => {
    const fixture = createFixture()
    const { hashSecret } = await import('../src/modules/bridge/domain/bridge-credential.js')
    fixture.repository.validLegacyHashes.add(hashSecret(legacyToken))
    const app = Fastify({ logger: false })
    await app.register(bridgeCredentialRoutes, { prefix: '/api/v4', service: fixture.service })

    const exchange = await app.inject({
      method: 'POST',
      url: '/api/v4/bridge/legacy-credential-exchanges',
      payload: {
        schema_version: 1,
        legacy_refresh_token: legacyToken,
        installation_id: 'install-01',
        profile_id: 'default',
        source_fingerprint: fingerprint,
      },
    })
    expect(exchange.statusCode).toBe(200)
    const refresh = exchange.json().data.refresh_token as string
    expect(exchange.json()).toMatchObject({
      data: { credential_type: 'bridge_refresh', generation: 1 },
      meta: { request_id: expect.any(String), generated_at: expect.stringMatching(/Z$/) },
    })

    const session = await app.inject({
      method: 'POST',
      url: '/api/v4/bridge/session-tokens',
      payload: {
        refresh_token: refresh,
        installation_id: 'install-01',
        profile_id: 'default',
      },
    })
    expect(session.statusCode).toBe(201)
    expect(session.json()).toMatchObject({
      data: {
        credential_type: 'bridge_session',
        expires_in_seconds: 30,
        websocket_path: '/bridge/v4/ws',
      },
      meta: { request_id: expect.any(String) },
    })
    const revokeInput = { refresh_token: refresh, installation_id: 'install-01', profile_id: 'default' }
    for (let attempt = 0; attempt < 2; attempt++) {
      const revoked = await app.inject({ method: 'POST', url: '/api/v4/bridge/credential-revocations', payload: revokeInput })
      expect(revoked.statusCode).toBe(200)
      expect(revoked.json()).toMatchObject({ data: { credential_type: 'bridge_revocation', installation_id: 'install-01',
        profile_id: 'default', generation: 1, revoked: true }, meta: { request_id: expect.any(String) } })
      expect(revoked.body).not.toContain(refresh)
    }
    const after = await app.inject({ method: 'POST', url: '/api/v4/bridge/session-tokens', payload: revokeInput })
    expect(after.statusCode).toBe(401)
    await app.close()
  })

  it('uses the V4 envelope and never reflects the legacy secret in errors', async () => {
    const fixture = createFixture()
    const app = Fastify({ logger: false })
    await app.register(bridgeCredentialRoutes, { prefix: '/api/v4', service: fixture.service })

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/v4/bridge/legacy-credential-exchanges',
      payload: {
        schema_version: 1,
        legacy_refresh_token: legacyToken,
        installation_id: 'bad id',
        profile_id: 'default',
        source_fingerprint: fingerprint,
      },
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.body).not.toContain(legacyToken)
    expect(invalid.json()).toMatchObject({
      code: 'bridge_credential_request_invalid',
      retryable: false,
    })

    const unauthorized = await app.inject({
      method: 'POST',
      url: '/api/v4/bridge/legacy-credential-exchanges',
      payload: {
        schema_version: 1,
        legacy_refresh_token: legacyToken,
        installation_id: 'install-01',
        profile_id: 'default',
        source_fingerprint: fingerprint,
      },
    })
    expect(unauthorized.statusCode).toBe(401)
    expect(unauthorized.body).not.toContain(legacyToken)
    expect(unauthorized.json()).toMatchObject({
      code: 'bridge_legacy_credential_invalid',
      correlation_id: expect.any(String),
    })

    const malformed = await app.inject({
      method: 'POST',
      url: '/api/v4/bridge/legacy-credential-exchanges',
      headers: { 'content-type': 'application/json' },
      payload: `{"legacy_refresh_token":"${legacyToken}"`,
    })
    expect(malformed.statusCode).toBe(400)
    expect(malformed.body).not.toContain(legacyToken)
    expect(malformed.json()).toMatchObject({ code: 'bridge_credential_request_invalid' })
    await app.close()
  })
})
