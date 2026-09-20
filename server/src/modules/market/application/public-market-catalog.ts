import type { SettingReader } from '../../settings/index.js'
import { parseStandardMarketSymbols } from '../../../shared/standard-market-symbols.js'

export class PublicMarketCatalog {
  constructor(private readonly settings: SettingReader) {}
  async list(): Promise<string[]> {
    const value = await this.settings.read({ namespace: 'market_data', key: 'symbols', expectedType: 'json_array' })
    if (value.status !== 'found' || value.rawValue === null) throw new Error('market_catalog_unavailable')
    return parseStandardMarketSymbols(JSON.parse(value.rawValue))
  }
}
