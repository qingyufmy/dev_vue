import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, expect, test } from 'vitest'
import { encryptLocalBackup, decryptLocalBackup } from '../scripts/lib/local-backup-stream.mjs'

const paths = []
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }) })
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'aurum-backup-stream-')); paths.push(dir)
  return { dir, encrypted: join(dir, 'source.enc'), restored: join(dir, 'restore.sql'), key: randomBytes(32) }
}
test('round trips binary and UTF-8 bytes without exposing a key in metadata', async () => {
  const f = await fixture(), original = Buffer.concat([Buffer.from('中文\n\0\r\n'), randomBytes(100000)])
  const report = await encryptLocalBackup(Readable.from([original]), f.encrypted, f.key)
  expect(JSON.stringify(report)).not.toContain(f.key.toString('hex'))
  await decryptLocalBackup(f.encrypted, f.restored, f.key, report)
  expect(await readFile(f.restored)).toEqual(original)
})
test.each(['ciphertext', 'key', 'tag', 'digest'])('rejects altered %s and removes unverified plaintext', async kind => {
  const f = await fixture()
  const report = await encryptLocalBackup(Readable.from([Buffer.from('sensitive SQL')]), f.encrypted, f.key)
  if (kind === 'ciphertext') { const bytes = await readFile(f.encrypted); bytes[0] ^= 1; await writeFile(f.encrypted, bytes) }
  if (kind === 'key') f.key = randomBytes(32)
  if (kind === 'tag') report.tag = '00'.repeat(16)
  if (kind === 'digest') report.plaintext.sha256 = '00'.repeat(32)
  await expect(decryptLocalBackup(f.encrypted, f.restored, f.key, report)).rejects.toThrow('local_backup_decryption_failed')
  await expect(access(f.restored)).rejects.toThrow()
})
test('never overwrites an existing output on encrypt or decrypt', async () => {
  const f = await fixture()
  const report = await encryptLocalBackup(Readable.from(['original']), f.encrypted, f.key)
  const original = await readFile(f.encrypted)
  await expect(encryptLocalBackup(Readable.from(['replacement']), f.encrypted, f.key)).rejects.toThrow()
  expect(await readFile(f.encrypted)).toEqual(original)
  await writeFile(f.restored, 'keep')
  await expect(decryptLocalBackup(f.encrypted, f.restored, f.key, report)).rejects.toThrow()
  expect(await readFile(f.restored, 'utf8')).toBe('keep')
})
test('bounds both export and decrypted plaintext size', async () => {
  const f = await fixture()
  await expect(encryptLocalBackup(Readable.from(['too large']), f.encrypted, f.key, { maxBytes: 2 })).rejects.toThrow()
  const second = join(f.dir, 'second.enc')
  const report = await encryptLocalBackup(Readable.from(['too large']), second, f.key)
  await expect(decryptLocalBackup(second, f.restored, f.key, report, { maxBytes: 2 })).rejects.toThrow()
  await expect(access(f.restored)).rejects.toThrow()
})
test('an interrupted producer cannot return a successful backup artifact', async () => {
  const f = await fixture()
  async function* interrupted() { yield Buffer.from('partial SQL'); throw Error('producer_failed') }
  await expect(encryptLocalBackup(Readable.from(interrupted()), f.encrypted, f.key)).rejects.toThrow('producer_failed')
})
