import { createPrivateKey, createPublicKey, sign } from 'node:crypto'
import type { IdTokenClaims, IdTokenSigner } from '../application/auth-ports.js'

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

export class Es256IdTokenSigner implements IdTokenSigner {
  private readonly privateKey
  private readonly publicJwk: Record<string, unknown>

  constructor(privateKeyPem: string, private readonly keyId: string) {
    this.privateKey = createPrivateKey(privateKeyPem)
    const publicKey = createPublicKey(this.privateKey)
    this.publicJwk = {
      ...publicKey.export({ format: 'jwk' }),
      kid: keyId,
      use: 'sig',
      alg: 'ES256',
    }
  }

  async sign(claims: IdTokenClaims) {
    const header = encode({ alg: 'ES256', typ: 'JWT', kid: this.keyId })
    const payload = encode({
      iss: claims.issuer,
      aud: claims.audience,
      sub: claims.subject,
      nonce: claims.nonce,
      auth_time: claims.authTimeSeconds,
      iat: claims.issuedAtSeconds,
      exp: claims.expiresAtSeconds,
      acr: claims.mfaLevel,
    })
    const unsigned = `${header}.${payload}`
    const signature = sign('sha256', Buffer.from(unsigned, 'ascii'), {
      key: this.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url')
    return `${unsigned}.${signature}`
  }

  jwks() { return { keys: [this.publicJwk] } }
}
