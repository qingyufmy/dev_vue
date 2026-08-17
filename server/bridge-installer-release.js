const VERIFIED_INSTALLER = Object.freeze({
  version:'3.0.3',
  buildDate:'2026-08-17',
  fullUrl:'https://qiniu.acadfx.com/bridge/bootstrapper/ed3b06c945a4a319f32756046a84d91b345178246b75f0d12423590147d1e974/LiangjianBridgeSetup.exe',
  fileSize:27254642,
  sha256:'ED3B06C945A4A319F32756046A84D91B345178246B75F0D12423590147D1E974',
  v3:true,
})

function validHttpsObjectUrl(value, sha256) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
      && !url.search && !url.hash
      && url.pathname === `/bridge/bootstrapper/${sha256.toLowerCase()}/LiangjianBridgeSetup.exe`
  } catch {
    return false
  }
}

function compareReleaseVersion(left, right) {
  const leftParts = left.split('.').map(BigInt)
  const rightParts = right.split('.').map(BigInt)
  const width = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < width; index += 1) {
    const leftPart = leftParts[index] || 0n
    const rightPart = rightParts[index] || 0n
    if (leftPart > rightPart) return 1
    if (leftPart < rightPart) return -1
  }
  return 0
}

export function resolveBridgeInstallerRelease(environment = process.env) {
  const url = String(environment.BRIDGE_INSTALLER_URL || '').trim()
  const version = String(environment.BRIDGE_INSTALLER_RELEASE_VERSION || '').trim()
  const buildDate = String(environment.BRIDGE_INSTALLER_BUILD_DATE || '').trim()
  const sha256 = String(environment.BRIDGE_INSTALLER_SHA256 || '').trim().toUpperCase()
  const sizeValue = String(environment.BRIDGE_INSTALLER_SIZE_BYTES || '').trim()
  if (![url, version, buildDate, sizeValue, sha256].some(Boolean)) return VERIFIED_INSTALLER
  const fileSize = Number(sizeValue)
  if (!validHttpsObjectUrl(url, sha256)
    || !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)
    || !/^\d{4}-\d{2}-\d{2}$/.test(buildDate)
    || !/^[A-F0-9]{64}$/.test(sha256)
    || !Number.isSafeInteger(fileSize) || fileSize <= 0 || fileSize > 512 * 1024 * 1024) {
    throw new Error('bridge_installer_release_configuration_invalid')
  }
  const configured = Object.freeze({
    version,
    buildDate,
    fullUrl:url,
    fileSize,
    sha256,
    v3:true,
  })
  const versionOrder = compareReleaseVersion(configured.version, VERIFIED_INSTALLER.version)
  if (versionOrder > 0
    || (versionOrder === 0 && configured.buildDate > VERIFIED_INSTALLER.buildDate)) {
    return configured
  }
  return VERIFIED_INSTALLER
}
