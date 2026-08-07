import { createLocalStorageProvider } from './local-storage-provider.js'
import { createQiniuStorageProvider } from './qiniu-storage-provider.js'
import { assertQiniuReady, getStorageLocalRoot, isQiniuConfigured, loadStorageConfig, resolveConfiguredProvider } from './storage-config.js'
import { normalizeStoragePurpose, validateStorageUpload } from './storage-policy.js'

export class StorageService {
  constructor({ config, localProvider, qiniuProvider } = {}) {
    this.config = config
    this.providers = {
      local: localProvider || createLocalStorageProvider({ root: config.media.local_root || getStorageLocalRoot() }),
      qiniu: qiniuProvider || null,
    }
  }

  configuredProvider(purpose) {
    return resolveConfiguredProvider(normalizeStoragePurpose(purpose), this.config.media)
  }

  providerFor(purpose) {
    const selected = this.configuredProvider(purpose)
    if (selected === 'qiniu') {
      assertQiniuReady(this.config)
      if (!this.providers.qiniu) this.providers.qiniu = createQiniuStorageProvider({ config: this.config.qiniu })
    }
    return this.providers[selected]
  }

  providerNamed(name, object = {}) {
    const selected = String(name || '').toLowerCase()
    if (!['local', 'qiniu'].includes(selected)) throw new Error('storage_provider_invalid')
    if (selected === 'qiniu') {
      // Existing qiniu objects remain readable/deletable after an admin
      // changes the active purpose routing or lets a connection proof expire.
      // Only new providerFor() selections enforce the current test gate.
      if (!isQiniuConfigured(this.config.qiniu)) {
        const error = new Error('storage_qiniu_configuration_invalid')
        error.code = 'storage_qiniu_configuration_invalid'
        throw error
      }
      if (!this.providers.qiniu) this.providers.qiniu = createQiniuStorageProvider({ config: this.config.qiniu })
    }
    return this.providers[selected]
  }

  async put(context) {
    validateStorageUpload(context || {})
    return this.providerFor(context?.purpose).put(context)
  }
  async createDirectUpload(context) {
    validateStorageUpload(context || {})
    return this.providerFor(context?.purpose).createDirectUpload(context)
  }
  async confirmDirectUpload(session, result) {
    // A direct-upload session owns its provider. Do not re-resolve the
    // current default after an admin switches storage, otherwise a session
    // opened before the switch could be confirmed against the wrong backend.
    const provider = session?.provider || session?.storageProvider
    return (provider ? this.providerNamed(provider, session) : this.providerFor(session?.purpose || session?.filePurpose)).confirmDirectUpload(session, result)
  }
  async createReadUrl(object, viewer) {
    const provider = object?.provider || object?.storageProvider ? this.providerNamed(object.provider || object.storageProvider, object) : this.providerFor(object?.purpose)
    return provider.createReadUrl(object, viewer)
  }
  async delete(object) {
    const provider = object?.provider || object?.storageProvider ? this.providerNamed(object.provider || object.storageProvider, object) : this.providerFor(object?.purpose)
    return provider.delete(object)
  }
  async stat(object) {
    const provider = object?.provider || object?.storageProvider ? this.providerNamed(object.provider || object.storageProvider, object) : this.providerFor(object?.purpose)
    return provider.stat(object)
  }
}

export async function createStorageService({ config, ...options } = {}) {
  const loadedConfig = config || await loadStorageConfig()
  return new StorageService({ config: loadedConfig, ...options })
}

export async function testStorageConnection(config, { provider = 'qiniu', qiniuProvider } = {}) {
  if (provider !== 'qiniu') throw new Error('storage_connection_provider_invalid')
  assertQiniuReady({ ...config, qiniuTest: { valid: true, configVersion: config.configVersion } })
  const client = qiniuProvider || createQiniuStorageProvider({ config: config.qiniu })
  return client.testConnection()
}
