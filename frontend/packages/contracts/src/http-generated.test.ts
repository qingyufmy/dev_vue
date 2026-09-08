import { expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
import type { ApiOperations, ApiWireSchemas, AuthLoginRequest, AuthorizationRequest, SessionResponse, SessionSummary } from './index'
import { authLoginRequestSchema, authLoginResponseSchema, authorizationRequestSchema, sessionResponseSchema, sessionSummarySchema } from './index'

it('keeps the existing auth parsers structurally compatible with generated wire contracts', () => {
  expectTypeOf<z.output<typeof authLoginRequestSchema>>().toExtend<AuthLoginRequest>()
  expectTypeOf<AuthLoginRequest>().toExtend<z.output<typeof authLoginRequestSchema>>()
  expectTypeOf<z.output<typeof authorizationRequestSchema>>().toEqualTypeOf<AuthorizationRequest>()
  expectTypeOf<z.output<typeof authLoginResponseSchema>>().toEqualTypeOf<ApiWireSchemas['AuthLoginResponse']>()
  expectTypeOf<z.output<typeof sessionResponseSchema>>().toEqualTypeOf<SessionResponse>()
  expectTypeOf<z.output<typeof sessionSummarySchema>>().toEqualTypeOf<SessionSummary>()
  expectTypeOf<ApiOperations['getApplicationSession']['responses'][200]['content']['application/json']>().toEqualTypeOf<SessionResponse>()
})

it('preserves auth surface and identity-center distinctions at compile time', () => {
  // @ts-expect-error An application session cannot use the identity-center surface.
  const invalidSurface: SessionSummary['app'] = 'auth'
  // @ts-expect-error Opaque user identifiers remain strings on the wire.
  const invalidUser: SessionSummary['user']['id'] = 7
  // @ts-expect-error Identity-center responses do not expose application permissions.
  type InvalidPermissions = ApiWireSchemas['AuthCenterSessionResponse']['data']['permissions']
  void invalidSurface
  void invalidUser
  expectTypeOf<InvalidPermissions>().toBeAny()
})
