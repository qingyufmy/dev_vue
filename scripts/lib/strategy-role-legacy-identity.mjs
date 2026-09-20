// Target legacy keys include the role because each source template produces two
// strategy identities. The migration map still addresses the original integer PK.
export function strategyRoleLegacyIdentity(sourceId, sourceVersion, role) {
  const positive = (value, max) => typeof value === 'string' && /^[1-9]\d*$/.test(value) && BigInt(value) <= max
  if (!positive(sourceId, 18446744073709551615n) || !positive(sourceVersion, 4294967295n)
    || !['analysis', 'trader'].includes(role)) throw Error('strategy_legacy_identity_invalid')
  return {
    sourceTable: 'auto_prompt_types', sourcePk: [{ type: 'integer', value: sourceId }],
    strategy: { legacySourceTable: 'auto_prompt_types', legacyId: `${sourceId}:${role}`, entityKind: `strategy-${role}` },
    version: { legacySourceTable: 'auto_prompt_types', legacyId: `${sourceId}:${role}:v${sourceVersion}`, entityKind: `strategy-version-${role}` },
  }
}
