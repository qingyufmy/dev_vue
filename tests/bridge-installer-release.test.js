import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolveBridgeInstallerRelease } from '../server/bridge-installer-release.js'

describe('bridge installer release descriptor', () => {
  it('keeps the verified static 3.0.0 installer when no dynamic descriptor is configured', () => {
    expect(resolveBridgeInstallerRelease({})).toMatchObject({
      version:'3.0.0',
      v3:true,
      buildDate:'2026-08-01',
      fileSize:26509253,
      sha256:'4514A61F9F7D7E88667240EDABDC39B20814567707870B0445E6BE567BC7F447',
      fullUrl:`https://qiniu.acadfx.com/bridge/bootstrapper/${'4514a61f9f7d7e88667240edabdc39b20814567707870b0445e6be567bc7f447'}/LiangjianBridgeSetup.exe`,
    })
  })

  it('accepts an immutable HTTPS V3 installer descriptor', () => {
    expect(resolveBridgeInstallerRelease({
      BRIDGE_INSTALLER_URL:`https://qiniu.acadfx.com/bridge/bootstrapper/${'b'.repeat(64)}/LiangjianBridgeSetup.exe`,
      BRIDGE_INSTALLER_RELEASE_VERSION:'3.1.0',
      BRIDGE_INSTALLER_BUILD_DATE:'2026-07-28',
      BRIDGE_INSTALLER_SIZE_BYTES:'84044167',
      BRIDGE_INSTALLER_SHA256:'b'.repeat(64),
    })).toMatchObject({
      version:'3.1.0', fileSize:84044167, sha256:'B'.repeat(64), v3:true,
    })
  })

  it('fails startup closed for a partial, mutable, or malformed V3 descriptor', () => {
    expect(() => resolveBridgeInstallerRelease({
      BRIDGE_INSTALLER_SHA256:'a'.repeat(64),
    })).toThrow('bridge_installer_release_configuration_invalid')
    expect(() => resolveBridgeInstallerRelease({
      BRIDGE_INSTALLER_URL:'http://qiniu.acadfx.com/latest.exe',
    })).toThrow('bridge_installer_release_configuration_invalid')
    expect(() => resolveBridgeInstallerRelease({
      BRIDGE_INSTALLER_URL:'https://qiniu.acadfx.com/latest.exe?replace=1',
      BRIDGE_INSTALLER_RELEASE_VERSION:'3.1.0',
      BRIDGE_INSTALLER_BUILD_DATE:'2026-07-28',
      BRIDGE_INSTALLER_SIZE_BYTES:'1',
      BRIDGE_INSTALLER_SHA256:'a'.repeat(64),
    })).toThrow('bridge_installer_release_configuration_invalid')
    expect(() => resolveBridgeInstallerRelease({
      BRIDGE_INSTALLER_URL:`https://qiniu.acadfx.com/prefix/bridge/bootstrapper/${'a'.repeat(64)}/LiangjianBridgeSetup.exe`,
      BRIDGE_INSTALLER_RELEASE_VERSION:'3.1.0',
      BRIDGE_INSTALLER_BUILD_DATE:'2026-07-28',
      BRIDGE_INSTALLER_SIZE_BYTES:'1',
      BRIDGE_INSTALLER_SHA256:'a'.repeat(64),
    })).toThrow('bridge_installer_release_configuration_invalid')
  })

  it('redirects authenticated legacy Windows download routes only after V3 activation', async () => {
    const source = await readFile(new URL('../server/index.js', import.meta.url), 'utf8')
    expect(source).toContain("bridgeInstallerRelease.v3")
    expect(source).toContain("['setup', 'exe', 'exe-file'].includes(platform)")
    expect(source).toContain('res.redirect(302, bridgeInstallerRelease.fullUrl)')
  })
})
