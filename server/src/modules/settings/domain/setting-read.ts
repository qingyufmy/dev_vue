export type SettingType = 'string' | 'boolean' | 'integer' | 'enum' | 'json_array' | 'credential'
export interface SettingMetadata { id: string; namespace: string; key: string; type: SettingType; sensitivity: 'public' | 'restricted' | 'secret'; revision: string }
export type SettingLookup = { status: 'missing' }
  | { status: 'protected'; metadata: SettingMetadata; valueState: 'null' | 'empty' | 'text' }
  | { status: 'found'; metadata: SettingMetadata; valueState: 'null' | 'empty' | 'text'; rawValue: string | null }
export interface SettingReader {
  read(input: { namespace: string; key: string; expectedType: SettingType }): Promise<SettingLookup>
}
