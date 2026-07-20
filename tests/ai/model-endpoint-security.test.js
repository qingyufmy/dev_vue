import { afterEach, describe, expect, it } from 'vitest'
import {
  assertSafeModelEndpoint,
  isPrivateOrReservedAddress,
  normalizeModelBaseUrl,
} from '../../server/routes/ai/model-endpoint-security.js'

const originalOverride = process.env.AI_ALLOW_PRIVATE_MODEL_ENDPOINTS

afterEach(() => {
  if (originalOverride === undefined) delete process.env.AI_ALLOW_PRIVATE_MODEL_ENDPOINTS
  else process.env.AI_ALLOW_PRIVATE_MODEL_ENDPOINTS = originalOverride
})

describe('model endpoint security', () => {
  it('rejects credentials, insecure protocols, and obvious local endpoints', () => {
    expect(() => normalizeModelBaseUrl('https://user:pass@api.example.com/v1')).toThrow('model_endpoint_credentials_forbidden')
    expect(() => normalizeModelBaseUrl('http://api.example.com/v1')).toThrow('model_endpoint_https_required')
    expect(() => normalizeModelBaseUrl('https://localhost:3000/v1')).toThrow('model_endpoint_private_network_forbidden')
    expect(() => normalizeModelBaseUrl('https://127.0.0.1/v1')).toThrow('model_endpoint_private_network_forbidden')
    expect(() => normalizeModelBaseUrl('https://[::1]/v1')).toThrow('model_endpoint_private_network_forbidden')
  })

  it('recognizes private and reserved IPv4/IPv6 addresses', () => {
    for (const address of ['10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.1.1', '172.16.0.1', '192.168.1.1', '::1', '::ffff:7f00:1', 'fd00::1', 'fe80::1']) {
      expect(isPrivateOrReservedAddress(address)).toBe(true)
    }
    expect(isPrivateOrReservedAddress('1.1.1.1')).toBe(false)
    expect(isPrivateOrReservedAddress('2606:4700:4700::1111')).toBe(false)
  })

  it('does not perform DNS resolution for hostnames', async () => {
    const lookup = async () => { throw new Error('dns_should_not_be_called') }
    await expect(assertSafeModelEndpoint('https://models.example.org/v1/chat/completions', { lookup }))
      .resolves.toBeInstanceOf(URL)
  })

  it('accepts a public HTTPS endpoint and strips query and fragment from saved base URLs', async () => {
    await expect(assertSafeModelEndpoint('https://models.example.org/v1/chat/completions')).resolves.toBeInstanceOf(URL)
    expect(normalizeModelBaseUrl('https://models.example.org/v1/?token=bad#part')).toBe('https://models.example.org/v1')
  })

  it('requires an explicit server-side override for private development endpoints', () => {
    process.env.AI_ALLOW_PRIVATE_MODEL_ENDPOINTS = 'true'
    expect(normalizeModelBaseUrl('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/v1')
  })
})
