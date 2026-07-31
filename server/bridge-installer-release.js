const VERIFIED_INSTALLER = Object.freeze({
  version:'3.0.0',
  buildDate:'2026-07-31',
  fullUrl:'https://qiniu.acadfx.com/bridge/bootstrapper/38ce5a8bf81750faafbe44be956ceed14aed8fccc4f8bf5012d18f2387e5e22f/LiangjianBridgeSetup.exe',
  fileSize:26491005,
  sha256:'38CE5A8BF81750FAAFBE44BE956CEED14AED8FCCC4F8BF5012D18F2387E5E22F',
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
  return Object.freeze({
    version,
    buildDate,
    fullUrl:url,
    fileSize,
    sha256,
    v3:true,
  })
}
