export async function createPairingCode(cryptoApi: Crypto = globalThis.crypto) {
  if (!cryptoApi?.subtle) throw new Error('secure_context_required')
  const bytes = cryptoApi.getRandomValues(new Uint8Array(32))
  const code = `bpc_${btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
  bytes.fill(0)
  const hash = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(code))
  return { code, hash: Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join(''), key: cryptoApi.randomUUID() }
}
