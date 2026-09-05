import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream, constants } from 'node:fs'
import { lstat, open, realpath, statfs } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { Transform, Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { requireBackup as check, verifyBackupArtifact } from './v4-backup-artifact.mjs'

export const MAX_BACKUP_BYTES = 4 * 1024 ** 3
export const MIN_FREE_BYTES = 10n * 1024n ** 3n

export async function privatePath(path, { directory = false } = {}) {
  check(isAbsolute(path) && resolve(path) === path, 'backup_path_invalid')
  let part = path
  while (true) {
    const info = await lstat(part)
    check(!info.isSymbolicLink(), 'backup_path_symlink')
    if (part === dirname(part)) break
    part = dirname(part)
  }
  check(await realpath(path) === path, 'backup_path_alias')
  const info = await lstat(path)
  check(directory ? info.isDirectory() : info.isFile() && info.nlink === 1, 'backup_path_type_invalid')
  check(info.uid === process.getuid() && (info.mode & 0o777) === (directory ? 0o700 : 0o600), 'backup_path_permissions_invalid')
}

export async function checkCapacity(paths, minBytes = MIN_FREE_BYTES) {
  for (const path of paths) {
    const stat = await statfs(path, { bigint: true })
    check(stat.bavail * stat.bsize >= minBytes && stat.ffree >= 1000n, 'backup_capacity_insufficient')
  }
}

export async function writePrivateJson(file, value) {
  const handle = await open(file, 'wx', 0o600)
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync() }
  finally { await handle.close() }
}

export async function hashArtifact(file) {
  await privatePath(file)
  const hash = createHash('sha256')
  let bytes = 0n
  for await (const chunk of createReadStream(file)) {
    bytes += BigInt(chunk.length)
    check(bytes <= BigInt(MAX_BACKUP_BYTES), 'backup_artifact_too_large')
    hash.update(chunk)
  }
  const result = { bytes: bytes.toString(), sha256: hash.digest('hex') }
  await verifyBackupArtifact(file, result, { maxBytes: MAX_BACKUP_BYTES })
  return result
}

// Every child has an independent, bounded lifecycle. No shell, inherited secret environment,
// argv password, raw stderr forwarding, or success based only on the last pipeline process.
export async function runBackupPipeline(stages, { input, output, timeoutMs = 30 * 60 * 1000,
  maxBytes = MAX_BACKUP_BYTES, capacityPaths = [], capacityEveryMs = 5000 } = {}) {
  check(stages.length > 0 && stages.length <= 4, 'backup_pipeline_invalid')
  const children = []
  const jobs = []
  let file, timer, capacityTimer, failure, checking = false
  const stop = error => {
    failure ??= error
    for (const child of children) child.kill('SIGKILL')
  }
  let bytes = 0n
  const hash = createHash('sha256')
  const meter = new Transform({ transform(chunk, encoding, callback) {
    bytes += BigInt(chunk.length)
    if (bytes > BigInt(maxBytes)) { callback(new Error('limit')); return }
    hash.update(chunk); callback(null, chunk)
  } })
  const capture = []
  const stageMetrics = stages.map(() => ({ bytes: 0n, hash: createHash('sha256') }))
  const stageMeter = index => new Transform({ transform(chunk, enc, done) {
    const metric = stageMetrics[index]
    metric.bytes += BigInt(chunk.length)
    if (metric.bytes > BigInt(maxBytes)) { done(new Error('limit')); return }
    metric.hash.update(chunk); done(null, chunk)
  } })
  try {
    await checkCapacity(capacityPaths)
    if (output) file = await open(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    for (const stage of stages) {
      check(isAbsolute(stage.command) && Array.isArray(stage.args), 'backup_process_invalid')
      const child = spawn(stage.command, stage.args, { shell: false, windowsHide: true,
        env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' },
        stdio: ['pipe', 'pipe', 'pipe', stage.secretFd ?? 'ignore'] })
      children.push(child)
      // Drain but do not keep or print provider errors; they can contain SQL row payloads.
      child.stderr.resume()
      const done = new Promise((resolveDone, reject) => {
        child.once('error', () => reject(new Error('spawn')))
        child.once('close', (code, signal) => code === 0 && !signal ? resolveDone() : reject(new Error('exit')))
      })
      jobs.push(done.catch(error => { stop(error); throw error }))
    }
    timer = setTimeout(() => stop(new Error('timeout')), timeoutMs)
    capacityTimer = setInterval(async () => {
      if (checking || failure) return
      checking = true
      try { await checkCapacity(capacityPaths) } catch (error) { stop(error) }
      finally { checking = false }
    }, capacityEveryMs)
    const source = input ?? Readable.from([])
    jobs.push(pipeline(source, children[0].stdin).catch(error => { stop(error); throw error }))
    for (let i = 1; i < children.length; i++) {
      jobs.push(pipeline(children[i - 1].stdout, stageMeter(i - 1), children[i].stdin).catch(error => { stop(error); throw error }))
    }
    const sink = new Writable({ write(chunk, enc, done) {
      if (!file) { capture.push(Buffer.from(chunk)); done(); return }
      const writeChunk = async () => {
        let offset = 0
        while (offset < chunk.length) {
          const result = await file.write(chunk, offset, chunk.length - offset)
          check(result.bytesWritten > 0, 'backup_output_write_failed')
          offset += result.bytesWritten
        }
      }
      writeChunk().then(() => done(), done)
    } })
    jobs.push(pipeline(children.at(-1).stdout, stageMeter(children.length - 1), meter, sink).catch(error => { stop(error); throw error }))
    const results = await Promise.allSettled(jobs)
    check(!failure && results.every(item => item.status === 'fulfilled'), 'backup_process_failed')
    if (file) await file.sync()
    return { bytes: bytes.toString(), sha256: hash.digest('hex'),
      stages: stageMetrics.map(metric => ({ bytes: metric.bytes.toString(), sha256: metric.hash.digest('hex') })),
      ...(output ? {} : { output: Buffer.concat(capture) }) }
  } finally {
    clearTimeout(timer); clearInterval(capacityTimer)
    for (const child of children) if (child.exitCode === null) child.kill('SIGKILL')
    await Promise.allSettled(jobs)
    await file?.close()
  }
}
