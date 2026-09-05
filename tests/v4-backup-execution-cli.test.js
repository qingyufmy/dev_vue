import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'

const exec = promisify(execFile)
const script = resolve('scripts/execute-v4-backup.mjs')
const run = args => exec(process.execPath, [script, ...args], { timeout: 5000, env: { PATH: process.env.PATH } })
describe('explicit backup execution CLI', () => {
  it('offers help without reading credentials or connecting a database', async () => {
    const { stdout, stderr } = await run(['help'])
    expect(stdout).toContain('--confirm-no-source-ddl')
    expect(stdout).toContain('No resume or cleanup')
    expect(stderr).toBe('')
  })
  it('rejects cleanup, incomplete approval, extra arguments and arbitrary database targets', async () => {
    for (const args of [[], ['cleanup'], ['execute'],
      ['execute', '--run-id=20260905-01', '--server-uuid=ac423207-6ef3-11f1-b302-000c29fda104'],
      ['execute', '--run-id=dev_vue', '--server-uuid=unknown', '--confirm-no-source-ddl'],
      ['execute', '--run-id=20260905-01', '--server-uuid=unknown', '--confirm-no-source-ddl', '--force'],
    ]) {
      try { await run(args); expect.unreachable('must refuse') }
      catch (error) {
        expect(error.code).toBe(1)
        expect(JSON.parse(error.stderr)).toMatchObject({ status: 'failed' })
        expect(error.stderr).not.toContain('Error:')
        expect(error.stdout).toBe('')
      }
    }
  })
})
