export function parseStrategyReferenceRequirement(value: unknown): 'required' | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('strategy_reference_requirement_invalid')
  const config = value as Record<string, unknown>
  if (Object.keys(config).length !== 2 || config.version !== 1 || config.mode !== 'required') {
    throw Error('strategy_reference_requirement_invalid')
  }
  return 'required'
}
