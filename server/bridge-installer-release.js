const VERIFIED_INSTALLER = Object.freeze({
  version:'3.0.0',
  buildDate:'2026-08-02',
  fullUrl:'https://qiniu.acadfx.com/bridge/bootstrapper/79389afd8ef9fe5e9687399d0fd96d5c50767586c46382e117c1f079287fd7b9/LiangjianBridgeSetup.exe',
  fileSize:26521132,
  sha256:'79389AFD8EF9FE5E9687399D0FD96D5C50767586C46382E117C1F079287FD7B9',
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
