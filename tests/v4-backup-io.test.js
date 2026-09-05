import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { runBackupPipeline } from '../scripts/lib/v4-backup-io.mjs'

const directories = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})
const child = source => ({ command: process.execPath, args: ['-e', source] })
const echo = child('process.stdin.pipe(process.stdout)')
describe('bounded backup process pipeline', () => {
  it('preserves binary bytes and hashes each stage, exclusively creates output', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'v4-backup-io-')); directories.push(directory)
    const output = join(directory, 'fixture.bin')
    const bytes = Buffer.from([0, 255, 13, 10, 128, 39, 59])
    const result = await runBackupPipeline([echo, echo], { input: Readable.from([bytes]), output, timeoutMs: 5000 })
    expect(await readFile(output)).toEqual(bytes)
    expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(result.stages).toEqual([{ bytes: '7', sha256: result.sha256 }, { bytes: '7', sha256: result.sha256 }])
    await expect(runBackupPipeline([echo], { input: Readable.from([Buffer.from('overwrite')]), output })).rejects.toThrow()
    expect(await readFile(output)).toEqual(bytes)
  })
  it('does not accept a successful last child when an upstream process fails', async () => {
    await expect(runBackupPipeline([child('process.stdout.write("partial");process.stderr.write("SECRET");process.exitCode=2'), echo], { timeoutMs: 5000 })).rejects.toThrow('backup_process_failed')
  })
  it('bounds intermediate output before downstream compression/discard', async () => {
    await expect(runBackupPipeline([child('process.stdout.write("x".repeat(10000))'), child('process.stdin.resume()')], { maxBytes: 100, timeoutMs: 5000 })).rejects.toThrow('backup_process_failed')
  })
  it('kills a stalled child at the deadline', async () => {
    await expect(runBackupPipeline([child('setInterval(()=>{},1000)')], { timeoutMs: 150 })).rejects.toThrow('backup_process_failed')
  })
  it('bounds stdout capture and handles spawn errors without raw output', async () => {
    await expect(runBackupPipeline([child('process.stdout.write("SECRET".repeat(1000))')], { maxBytes: 32 })).rejects.toThrow('backup_process_failed')
    await expect(runBackupPipeline([{ command: join(tmpdir(), 'missing-v4-backup-command'), args: [] }], { timeoutMs: 500 })).rejects.toThrow('backup_process_failed')
  })
})
