import { Readable } from 'node:stream'
import { expect, test } from 'vitest'
import { runLocalBackupProcess, discardLocalBackupOutput } from '../scripts/lib/local-backup-process.mjs'

const run = (code, extra = {}) => runLocalBackupProcess({ command: process.execPath, args: ['-e', code],
  consume: discardLocalBackupOutput, timeoutMs: 2000, ...extra })
test('waits for output and a successful process exit', async () => {
  expect(await run('process.stdin.pipe(process.stdout)', { input: Readable.from(['abc']) })).toEqual({ bytes: 3 })
})
test('rejects nonzero exit even after complete output', async () => {
  await expect(run("process.stdout.write('complete');process.exitCode=2")).rejects.toThrow('local_backup_process_failed')
})
test('does not expose provider stderr in its exception', async () => {
  await expect(run("process.stderr.write('credential=secret row=private');process.exitCode=1")).rejects.toThrow(/^local_backup_process_failed$/)
})
test('a timed out process is killed and observed before returning', async () => {
  await expect(run('setInterval(()=>{},100)', { timeoutMs: 50 })).rejects.toThrow('local_backup_process_failed')
})
test('consumer failure terminates a live producer', async () => {
  await expect(run("setInterval(()=>process.stdout.write('chunk'),10)", {
    consume: async stream => { for await (const chunk of stream) { if (chunk.length) throw Error('storage_failed') } },
  })).rejects.toThrow('local_backup_process_failed')
})
test('input failure prevents an apparent successful consumer result', async () => {
  async function* input() { yield Buffer.from('partial'); throw Error('source_failed') }
  await expect(run('process.stdin.resume()', { input: Readable.from(input()) })).rejects.toThrow('local_backup_process_failed')
})
test('spawn failure is sanitized', async () => {
  await expect(run('', { command: process.execPath + '.missing' })).rejects.toThrow('local_backup_process_failed')
})
test('unused output is bounded', async () => {
  await expect(run("process.stdout.write('123456')", { consume: stream => discardLocalBackupOutput(stream, 2) })).rejects.toThrow('local_backup_process_failed')
})
