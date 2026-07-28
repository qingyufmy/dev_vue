import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import qiniu from 'qiniu'

function fail(code) {
  throw Object.assign(new Error(code), { code })
}

function argumentsMap(values) {
  const result = new Map()
  for (let index = 0; index < values.length; index += 2) {
    if (!values[index]?.startsWith('--') || index + 1 >= values.length) fail('release_arguments_invalid')
    result.set(values[index].slice(2), values[index + 1])
  }
  return result
}

function required(map, key) {
  const value = map.get(key)
  if (!value) fail(`release_${key.replaceAll('-', '_')}_required`)
  return value
}

export function canonicalPackage(pkg) {
  return `AURUM-PACKAGE-V1\n${pkg.module_id}\n${pkg.version}\n${pkg.url}\n${pkg.size_bytes}\n${pkg.sha256.toLowerCase()}\n${pkg.minimum_core_version || ''}\n${pkg.maximum_core_version || ''}\n`
}

export function canonicalManifest(value) {
  let result = `AURUM-RELEASE-V2\n2\n${value.release_id}\n${value.release_version}\n${value.generated_at_utc_msc}\n${value.published_at_utc_msc}\n${value.expires_at_utc_msc}\n${value.priority}\n${value.minimum_launcher_version}\n${value.minimum_idle_seconds}\n${value.activation_deadline_utc_msc ?? ''}\n${value.rollout_channel}\n${value.rollout_percentage}\n`
  for (const pkg of [...value.packages].sort((a, b) => a.module_id.localeCompare(b.module_id, 'en'))) {
    result += `${pkg.module_id}|${pkg.version}|${pkg.url}|${pkg.size_bytes}|${pkg.sha256.toLowerCase()}|${pkg.signature}|${pkg.minimum_core_version || ''}|${pkg.maximum_core_version || ''}\n`
  }
  return result
}

async function sha256(file) {
  const hash = createHash('sha256')
  const bytes = await readFile(file)
  hash.update(bytes)
  return hash.digest('hex')
}

function isDryRun(args) {
  return args.get('dry-run') === 'true'
}

function serverUrl(args) {
  const value = required(args, 'server').replace(/\/$/, '')
  const url = new URL(value)
  const localHttp = url.protocol === 'http:' && ['127.0.0.1', '::1', 'localhost'].includes(url.hostname)
  if (url.username || url.password || url.pathname !== '/' && url.pathname !== '' || url.search || url.hash
    || url.protocol !== 'https:' && !localHttp) fail('release_server_url_invalid')
  return value
}

export function immutablePackageKey(manifest, pkg) {
  return `bridge/releases/${manifest.release_version}/${pkg.sha256.toLowerCase()}/${pkg.module_id}.zip`
}

async function artifactPlan(manifest, artifactDirectory) {
  const planned = []
  let origin = null
  for (const pkg of manifest.packages) {
    const localFile = path.join(artifactDirectory, `${pkg.module_id}.zip`)
    const info = await stat(localFile)
    if (info.size !== pkg.size_bytes || await sha256(localFile) !== pkg.sha256.toLowerCase()) fail('release_local_artifact_mismatch')
    const url = new URL(pkg.url)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail('release_package_url_invalid')
    origin ||= url.origin
    if (origin !== url.origin) fail('release_package_origin_mismatch')
    const key = decodeURIComponent(url.pathname.slice(1))
    if (key !== immutablePackageKey(manifest, pkg)) fail('release_package_key_invalid')
    planned.push({ module_id:pkg.module_id, local_file:localFile, key, url:pkg.url })
  }
  return { origin, planned }
}

async function runSigner(signer, input, output) {
  await new Promise((resolve, reject) => {
    const child = spawn(signer, ['sign', '--input', input, '--output', output], {
      stdio:['ignore', 'ignore', 'inherit'],
      windowsHide:true,
    })
    child.once('error', reject)
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('release_signer_failed')))
  })
  const signature = (await readFile(output, 'utf8')).trim()
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signature) || signature.length > 1024) fail('release_signature_invalid')
  return signature
}

async function sign(args) {
  const manifestPath = path.resolve(required(args, 'manifest'))
  const signer = path.resolve(required(args, 'signer'))
  const output = path.resolve(required(args, 'output'))
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'aurum-sign-'))
  try {
    for (const pkg of manifest.packages) {
      const input = path.join(temporary, `${pkg.module_id}.payload`)
      const signature = path.join(temporary, `${pkg.module_id}.signature`)
      await writeFile(input, canonicalPackage(pkg), { flag:'wx' })
      pkg.signature = await runSigner(signer, input, signature)
    }
    const input = path.join(temporary, 'manifest.payload')
    const signature = path.join(temporary, 'manifest.signature')
    await writeFile(input, canonicalManifest(manifest), { flag:'wx' })
    manifest.signature = await runSigner(signer, input, signature)
    await writeFile(output, JSON.stringify(manifest, null, 2), { flag:'wx' })
    return { operation:'sign', manifest:output, release_id:manifest.release_id }
  } finally {
    await rm(temporary, { recursive:true, force:true })
  }
}

function qiniuConfig() {
  const accessKey = process.env.QINIU_ACCESS_KEY
  const secretKey = process.env.QINIU_SECRET_KEY
  const bucket = process.env.QINIU_BUCKET
  const domain = process.env.QINIU_DOMAIN?.replace(/\/$/, '')
  if (!accessKey || !secretKey || !bucket || !domain?.startsWith('https://')) fail('release_qiniu_configuration_missing')
  const mac = new qiniu.auth.digest.Mac(accessKey, secretKey)
  const config = new qiniu.conf.Config()
  const zones = { z0:'Zone_z0', z1:'Zone_z1', z2:'Zone_z2', na0:'Zone_na0', as0:'Zone_as0' }
  const zone = zones[process.env.QINIU_REGION || 'z0']
  if (!zone || !qiniu.zone[zone]) fail('release_qiniu_region_invalid')
  config.zone = qiniu.zone[zone]
  config.useHttpsDomain = true
  return { accessKey, bucket, config, domain, mac }
}

async function uploadOne(localFile, key, qiniuContext) {
  const policy = new qiniu.rs.PutPolicy({ scope:`${qiniuContext.bucket}:${key}`, insertOnly:1, expires:3600 })
  const token = policy.uploadToken(qiniuContext.mac)
  const uploader = new qiniu.resume_up.ResumeUploader(qiniuContext.config)
  const extra = qiniu.resume_up.PutExtra.create()
  extra.version = 'v2'
  let result
  try {
    result = await uploader.putFileV2(token, key, localFile, extra)
  } catch (error) {
    const status = error?.statusCode || error?.response?.statusCode || error?.response?.status
    if (status === 614) return null
    throw error
  }
  const { data, resp } = result
  if (resp.statusCode !== 200 || data.key !== key) fail('release_qiniu_upload_failed')
  return data.hash
}

async function upload(args) {
  const manifestPath = path.resolve(required(args, 'manifest'))
  const artifactDirectory = path.resolve(required(args, 'artifacts'))
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const plan = await artifactPlan(manifest, artifactDirectory)
  const manifestHash = await sha256(manifestPath)
  const manifestKey = `bridge/releases/${manifest.release_version}/${manifestHash}/manifest.json`
  if (isDryRun(args)) {
    return {
      operation:'upload', dry_run:true, release_id:manifest.release_id,
      planned:plan.planned.map(({ module_id, key, url }) => ({ module_id, key, url })),
      candidate_manifest:{ key:manifestKey, sha256:manifestHash, url:`${plan.origin}/${manifestKey}` },
    }
  }
  const context = qiniuConfig()
  if (plan.origin !== context.domain) fail('release_qiniu_domain_mismatch')
  const uploaded = []
  for (const item of plan.planned) {
    const etag = await uploadOne(item.local_file, item.key, context)
    uploaded.push({ module_id:item.module_id, key:item.key, url:item.url, etag })
  }
  await uploadOne(manifestPath, manifestKey, context)
  return {
    operation:'upload',
    release_id:manifest.release_id,
    uploaded,
    candidate_manifest:{ key:manifestKey, sha256:manifestHash, url:`${context.domain}/${manifestKey}` },
  }
}

async function verifyRemote(args) {
  const manifestPath = path.resolve(required(args, 'manifest'))
  const manifestBytes = await readFile(manifestPath)
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  const verified = []
  let origin = null
  for (const pkg of manifest.packages) {
    const packageUrl = new URL(pkg.url)
    origin ||= packageUrl.origin
    if (packageUrl.origin !== origin) fail('release_package_origin_mismatch')
    const response = await fetch(pkg.url, { cache:'no-store' })
    if (!response.ok) fail('release_remote_download_failed')
    const bytes = Buffer.from(await response.arrayBuffer())
    const digest = createHash('sha256').update(bytes).digest('hex')
    if (bytes.length !== pkg.size_bytes || digest !== pkg.sha256) fail('release_remote_artifact_mismatch')
    verified.push({ module_id:pkg.module_id, size_bytes:bytes.length, sha256:digest, url:pkg.url })
  }
  const manifestHash = createHash('sha256').update(manifestBytes).digest('hex')
  const manifestUrl = `${origin}/bridge/releases/${manifest.release_version}/${manifestHash}/manifest.json`
  const manifestResponse = await fetch(manifestUrl, { cache:'no-store' })
  if (!manifestResponse.ok) fail('release_remote_manifest_download_failed')
  const remoteManifest = Buffer.from(await manifestResponse.arrayBuffer())
  if (createHash('sha256').update(remoteManifest).digest('hex') !== manifestHash) fail('release_remote_manifest_mismatch')
  return {
    operation:'verify-remote', release_id:manifest.release_id, verified,
    candidate_manifest:{ url:manifestUrl, sha256:manifestHash },
  }
}

async function verifySignatures(args) {
  const manifestPath = path.resolve(required(args, 'manifest'))
  const artifactDirectory = path.resolve(required(args, 'artifacts'))
  const publicKey = createPublicKey(await readFile(path.resolve(required(args, 'public-key')), 'utf8'))
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  for (const pkg of manifest.packages) {
    const localFile = path.join(artifactDirectory, `${pkg.module_id}.zip`)
    const info = await stat(localFile)
    if (info.size !== pkg.size_bytes || await sha256(localFile) !== pkg.sha256) fail('release_local_artifact_mismatch')
    if (!verifySignature('sha256', Buffer.from(canonicalPackage(pkg)), {
      key:publicKey,
      dsaEncoding:'ieee-p1363',
    }, Buffer.from(pkg.signature, 'base64'))) fail('release_package_signature_invalid')
  }
  if (!verifySignature('sha256', Buffer.from(canonicalManifest(manifest)), {
    key:publicKey,
    dsaEncoding:'ieee-p1363',
  }, Buffer.from(manifest.signature, 'base64'))) fail('release_manifest_signature_invalid')
  return { operation:'verify-signatures', release_id:manifest.release_id, packages:manifest.packages.length }
}

async function endpoint(args, operation) {
  const baseUrl = serverUrl(args)
  const body = operation === 'publish'
    ? { manifest:JSON.parse(await readFile(path.resolve(required(args, 'manifest')), 'utf8')) }
    : {}
  if (isDryRun(args)) {
    return {
      operation, dry_run:true, endpoint:`${baseUrl}/api/admin/bridge/v3/releases/${operation}`,
      release_id:body.manifest?.release_id || null,
      release_version:body.manifest?.release_version || null,
    }
  }
  const token = process.env.AURUM_BRIDGE_RELEASE_API_TOKEN
  if (!token) fail('release_endpoint_configuration_missing')
  const response = await fetch(`${baseUrl}/api/admin/bridge/v3/releases/${operation}`, {
    method:'POST',
    headers:{ Authorization:`Bearer ${token}`, 'Content-Type':'application/json' },
    body:JSON.stringify(body),
  })
  const value = await response.json().catch(() => ({}))
  if (!response.ok || value.ok !== true) fail(`release_endpoint_${operation}_failed`)
  return { operation, response:value }
}

async function releaseHealth(args) {
  const baseUrl = serverUrl(args)
  const token = process.env.AURUM_BRIDGE_RELEASE_API_TOKEN
  if (!token) fail('release_endpoint_configuration_missing')
  const freshnessSeconds = args.get('freshness-seconds') || '90'
  if (!/^\d{2,3}$/.test(freshnessSeconds)
    || Number(freshnessSeconds) < 30 || Number(freshnessSeconds) > 600) {
    fail('release_freshness_seconds_invalid')
  }
  const response = await fetch(
    `${baseUrl}/api/admin/bridge/v3/releases/health?freshness_seconds=${freshnessSeconds}`,
    { cache:'no-store', headers:{ Authorization:`Bearer ${token}` } }
  )
  const value = await response.json().catch(() => ({}))
  if (!response.ok || value.ok !== true) fail('release_endpoint_health_failed')
  return { operation:'health', response:value }
}

async function verifyEndpoint(args) {
  const baseUrl = serverUrl(args)
  const manifest = JSON.parse(await readFile(path.resolve(required(args, 'manifest')), 'utf8'))
  const installationId = required(args, 'installation-id')
  const releaseChannel = required(args, 'release-channel')
  if (!/^install_[a-f0-9]{32}$/.test(installationId) || !['internal', 'stable'].includes(releaseChannel)) {
    fail('release_endpoint_identity_invalid')
  }
  const response = await fetch(`${baseUrl}/api/bridge/v3/releases/current`, {
    cache:'no-store',
    headers:{
      'X-Aurum-Installation-Id':installationId,
      'X-Aurum-Release-Channel':releaseChannel,
    },
  })
  if (!response.ok) fail('release_public_endpoint_failed')
  const value = await response.json().catch(() => null)
  if (!isDeepStrictEqual(value, manifest)) fail('release_public_manifest_mismatch')
  return {
    operation:'verify-endpoint', release_id:value.release_id, release_version:value.release_version,
    priority:value.priority, rollout_channel:value.rollout_channel,
    rollout_percentage:value.rollout_percentage,
    manifest_signature_sha256:createHash('sha256').update(value.signature, 'utf8').digest('hex'),
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  const args = argumentsMap(rest)
  const handlers = {
    sign:() => sign(args),
    'verify-signatures':() => verifySignatures(args),
    upload:() => upload(args),
    'verify-remote':() => verifyRemote(args),
    'verify-endpoint':() => verifyEndpoint(args),
    publish:() => endpoint(args, 'publish'),
    stop:() => endpoint(args, 'stop'),
    rollback:() => endpoint(args, 'rollback'),
    health:() => releaseHealth(args),
  }
  if (!handlers[command]) fail('release_command_invalid')
  const result = await handlers[command]()
  const resultPath = args.get('result')
  if (resultPath) await writeFile(path.resolve(resultPath), JSON.stringify({ ok:true, ...result }, null, 2), { flag:'wx' })
  process.stdout.write(`${JSON.stringify({ ok:true, ...result })}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${JSON.stringify({ ok:false, error:error.code || error.message || 'release_failed' })}\n`)
    process.exitCode = 1
  })
}
