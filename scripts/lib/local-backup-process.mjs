import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

// A completed output stream alone is not a completed mysqldump/mysql command.
// Do not propagate provider stderr, which can contain credentials or row data.
export async function runLocalBackupProcess({ command, args, input = Readable.from([]), consume,
  timeoutMs = 30 * 60 * 1000 }) {
  if (!isAbsolute(command ?? '') || !Array.isArray(args) || !args.every(arg => typeof arg === 'string')
    || typeof consume !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60 * 60 * 1000) {
    throw Error('local_backup_process_arguments')
  }
  const child = spawn(command, args, { shell: false, windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, PATH: process.env.PATH, TZ: 'UTC' },
    stdio: ['pipe', 'pipe', 'pipe'] })
  let failure, timer
  const fail = () => {
    failure ??= Error('local_backup_process_failed')
    child.kill()
    input.destroy()
    child.stdin.destroy()
    child.stdout.destroy()
  }
  child.stderr.resume()
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => code === 0 && !signal ? resolve() : reject(Error('exit')))
  })
  const guard = promise => promise.catch(error => { fail(); throw error })
  timer = setTimeout(fail, timeoutMs)
  try {
    const results = await Promise.allSettled([
      guard(exited), guard(pipeline(input, child.stdin)), guard(Promise.resolve().then(() => consume(child.stdout))),
    ])
    if (failure || results.some(result => result.status === 'rejected')) throw Error('local_backup_process_failed')
    return results[2].value
  } finally { clearTimeout(timer) }
}

export async function discardLocalBackupOutput(stream, maxBytes = 65536) {
  let bytes = 0
  for await (const chunk of stream) {
    bytes += chunk.length
    if (bytes > maxBytes) throw Error('local_backup_process_output_limit')
  }
  return { bytes }
}
