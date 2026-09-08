import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, unlink } from 'node:fs/promises'
import { Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const check = (value, code) => { if (!value) throw Error(`local_backup_${code}`) }
const limitDefault = 4 * 1024 ** 3
const keyValid = key => Buffer.isBuffer(key) && key.length === 32
const sink = file => new Writable({
  write(chunk, encoding, callback) { file.writeFile(chunk).then(() => callback(), callback) },
  final(callback) { file.sync().then(() => callback(), callback) },
})
function meter(maxBytes) {
  check(Number.isSafeInteger(maxBytes) && maxBytes > 0, 'limit_invalid')
  let bytes = 0
  const digest = createHash('sha256')
  const stream = new Transform({ transform(chunk, encoding, callback) {
    bytes += chunk.length
    if (bytes > maxBytes) { callback(Error('local_backup_size_limit')); return }
    digest.update(chunk); callback(null, chunk)
  } })
  return { stream, result: () => ({ bytes, sha256: digest.digest('hex') }) }
}

// Caller creates and verifies a private Windows ACL directory before calling.
// Key ownership/storage is separate from public artifact metadata.
export async function encryptLocalBackup(input, destination, key, { maxBytes = limitDefault } = {}) {
  check(keyValid(key), 'key_invalid')
  const plain = meter(maxBytes), encrypted = meter(maxBytes)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const file = await open(destination, 'wx', 0o600)
  try {
    await pipeline(input, plain.stream, cipher, encrypted.stream, sink(file))
    await file.sync()
    return { format: 'aurum-local-backup/aes-256-gcm/v1', iv: iv.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'), plaintext: plain.result(), ciphertext: encrypted.result() }
  } finally { await file.close() }
}

// Authentication and digest verification finish before this returns a usable SQL
// file. Never pipe unverified decrypted bytes directly into a database client.
export async function decryptLocalBackup(source, destination, key, artifact, { maxBytes = limitDefault } = {}) {
  check(keyValid(key) && artifact?.format === 'aurum-local-backup/aes-256-gcm/v1'
    && /^[a-f0-9]{24}$/.test(artifact.iv) && /^[a-f0-9]{32}$/.test(artifact.tag), 'artifact_invalid')
  const encrypted = meter(maxBytes), plain = meter(maxBytes)
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(artifact.iv, 'hex'))
  decipher.setAuthTag(Buffer.from(artifact.tag, 'hex'))
  const file = await open(destination, 'wx', 0o600)
  let verified = false
  try {
    await pipeline(createReadStream(source), encrypted.stream, decipher, plain.stream, sink(file))
    const actualEncrypted = encrypted.result(), actualPlain = plain.result()
    for (const [actual, expected] of [[actualEncrypted, artifact.ciphertext], [actualPlain, artifact.plaintext]]) {
      check(actual.bytes === expected?.bytes && actual.sha256 === expected?.sha256, 'digest_mismatch')
    }
    await file.sync()
    verified = true
    return actualPlain
  } catch {
    throw Error('local_backup_decryption_failed')
  } finally {
    await file.close()
    if (!verified) await unlink(destination)
  }
}
