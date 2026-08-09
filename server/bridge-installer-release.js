const VERIFIED_INSTALLER = Object.freeze({
  version:'3.0.0',
  buildDate:'2026-08-09',
  fullUrl:'https://qiniu.acadfx.com/bridge/bootstrapper/03c33da9bf279e344ea3d867a8a68a41dce0fac5aad38b6aa16197cac89e54bf/LiangjianBridgeSetup.exe',
  fileSize:26694812,
  sha256:'03C33DA9BF279E344EA3D867A8A68A41DCE0FAC5AAD38B6AA16197CAC89E54BF',
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
