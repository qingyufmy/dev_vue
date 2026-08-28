import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

function runPoolLifecycleProbe(timeoutMs = 1500) {
  return new Promise((resolve) => {
    let timer
    const child = spawn(process.execPath, [
      '--input-type=module',
      '--eval',
      "const { getDB } = await import('./server/db.js'); await getDB().end()",
    ], {
      cwd: repoRoot,
      stdio: 'ignore',
    })
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    child.once('exit', (code, signal) => finish({ code, signal, timedOut: false }))
    timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({ code: null, signal: 'SIGKILL', timedOut: true })
    }, timeoutMs)
  })
}

describe('database pool lifecycle', () => {
  it('does not keep standalone scripts alive after the pool is closed', async () => {
    await expect(runPoolLifecycleProbe()).resolves.toEqual({
      code: 0,
      signal: null,
      timedOut: false,
    })
  })
})
