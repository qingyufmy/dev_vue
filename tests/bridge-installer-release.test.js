import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolveBridgeInstallerRelease } from '../server/bridge-installer-release.js'

describe('bridge installer release descriptor', () => {
  it('keeps the verified static 3.0.0 installer when no dynamic descriptor is configured', () => {
    expect(resolveBridgeInstallerRelease({})).toMatchObject({
      version:'3.0.0',
      v3:true,
      buildDate:'2026-08-10',
      fileSize:26775589,
      sha256:'3B1857CD954142924DCFBE957BCDCFAD30B7BEFD2DB43EC8B81E514760FA54CA',
      fullUrl:`https://qiniu.acadfx.com/bridge/bootstrapper/${'3b1857cd954142924dcfbe957bcdcfad30b7befd2db43ec8b81e514760fa54ca'}/LiangjianBridgeSetup.exe`,
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
      version:'3.1.0', buildDate:'2026-07-28',
      fullUrl:`https://qiniu.acadfx.com/bridge/bootstrapper/${'b'.repeat(64)}/LiangjianBridgeSetup.exe`,
      fileSize:84044167, sha256:'B'.repeat(64), v3:true,
    })
  })

  it('does not let stale same-version runtime metadata replace the verified installer', () => {
    expect(resolveBridgeInstallerRelease({
      BRIDGE_INSTALLER_URL:`https://qiniu.acadfx.com/bridge/bootstrapper/${'c'.repeat(64)}/LiangjianBridgeSetup.exe`,
      BRIDGE_INSTALLER_RELEASE_VERSION:'3.0.0',
      BRIDGE_INSTALLER_BUILD_DATE:'2026-08-08',
      BRIDGE_INSTALLER_SIZE_BYTES:'84044167',
      BRIDGE_INSTALLER_SHA256:'c'.repeat(64),
    })).toMatchObject({
      version:'3.0.0',
      buildDate:'2026-08-10',
      fileSize:26775589,
      sha256:'3B1857CD954142924DCFBE957BCDCFAD30B7BEFD2DB43EC8B81E514760FA54CA',
    })
  })

  it('keeps the verified descriptor on a same-version same-date conflict', () => {
    expect(resolveBridgeInstallerRelease({
      BRIDGE_INSTALLER_URL:`https://qiniu.acadfx.com/bridge/bootstrapper/${'d'.repeat(64)}/LiangjianBridgeSetup.exe`,
      BRIDGE_INSTALLER_RELEASE_VERSION:'3.0.0',
      BRIDGE_INSTALLER_BUILD_DATE:'2026-08-10',
      BRIDGE_INSTALLER_SIZE_BYTES:'84044167',
      BRIDGE_INSTALLER_SHA256:'d'.repeat(64),
    })).toMatchObject({
      fullUrl:`https://qiniu.acadfx.com/bridge/bootstrapper/${'3b1857cd954142924dcfbe957bcdcfad30b7befd2db43ec8b81e514760fa54ca'}/LiangjianBridgeSetup.exe`,
    })
  })

  it('publishes the complete V3 version metadata contract', async () => {
    const source = await readFile(new URL('../server/routes/ai/index.js', import.meta.url), 'utf8')
    expect(source).toContain("router.get('/bridge/version'")
    expect(source).toContain("if (req.baseUrl !== '/api') return next()")
    for (const field of ['version:', 'build_date:', 'full_url:', 'file_size:', 'sha256:', 'v3:']) {
      expect(source).toContain(field)
    }
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

  it('does not expose the retired installer compatibility routes', async () => {
    const source = await readFile(new URL('../server/index.js', import.meta.url), 'utf8')
    expect(source).not.toContain("app.get('/ai/bridge/:platform'")
    expect(source).not.toContain('bridgeInstallerRelease')
    expect(source).not.toContain("app.get('/ai/bridge/config'")
    expect(source).not.toContain('AURUM_Bridge.exe')
    expect(source).not.toContain("platform === 'mac'")
  })

  it('does not expose retired Bridge login or session routes', async () => {
    const source = await readFile(new URL('../server/routes/auth.js', import.meta.url), 'utf8')
    expect(source).not.toContain("router.post('/auth/bridge-session'")
    expect(source).not.toContain("router.post('/auth/bridge-revoke'")
    expect(source).not.toContain("client === 'bridge'")
  })

  it('downloads only from the current version endpoint response', async () => {
    const source = await readFile(new URL('../public/ai/app.js', import.meta.url), 'utf8')
    const start = source.indexOf('$("downloadExe")?.addEventListener')
    const end = source.indexOf('async function updateBridgeRuntimeControl', start)
    const handler = source.slice(start, end)
    expect(handler).toContain('fetch("/api/bridge/version")')
    expect(handler).toContain('data.full_url')
    expect(handler).not.toContain('data.updater_url')
    expect(handler).not.toContain('qiniu.acadfx.com')
  })
})
