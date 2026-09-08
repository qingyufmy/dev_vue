import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'

const directories = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
const script = resolve('scripts/private-local-backup-directory.ps1')
const call = (mode, path) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script,
  '-Mode', mode, '-Path', path], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
test.skipIf(process.platform !== 'win32')('private ACL is verified, duplicate creation and widened permissions reject', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'aurum-backup-acl-')); directories.push(parent)
  const target = join(parent, 'private')
  expect(JSON.parse(call('Create', target)).verified).toBe(true)
  expect(JSON.parse(call('Verify', target)).verified).toBe(true)
  expect(() => call('Create', target)).toThrow()
  execFileSync('icacls.exe', [target, '/grant', '*S-1-1-0:(OI)(CI)R'], { windowsHide: true, stdio: 'pipe' })
  expect(() => call('Verify', target)).toThrow()
}, 15000)
test.skipIf(process.platform !== 'win32')('a normal inherited directory cannot masquerade as private', async () => {
  const target = await mkdtemp(join(tmpdir(), 'aurum-backup-inherited-')); directories.push(target)
  expect(() => call('Verify', target)).toThrow()
})
