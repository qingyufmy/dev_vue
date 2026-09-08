// Compare only type declarations. Nullability/defaults/collations/constraints and
// business meaning remain separate review obligations, even when tokens match.
export function databaseTypeToken(declaration) {
  const token = /^[a-z]+(?:\([^)]*\))?(?:\s+unsigned)?/i.exec(declaration)?.[0]
  if (!token) return null
  if (/^enum\(/i.test(token)) return 'enum' + token.slice(4).replace(/,\s*(?=')/g, ',')
  return token.toLowerCase().replace(/^(tinyint|smallint|mediumint|int|bigint)\(\d+\)/, '$1')
}

// Default comparison supports the scalar forms used by the frozen V4 plan.
// Unknown expressions remain explicit review items, never assumed equivalent.
export function plannedDefault(declaration) {
  const match = /\bDEFAULT\s+(.+)$/i.exec(declaration)
  if (!match) return { kind: 'value', value: null }
  const text = match[1]
  if (/^NULL\b/i.test(text)) return { kind: 'value', value: null }
  const literal = /^'((?:''|\\.|[^'])*)'/.exec(text)
  if (literal && !literal[1].includes('\\')) return { kind: 'value', value: literal[1].replaceAll("''", "'") }
  const number = /^(-?\d+(?:\.\d+)?)(?=\s|,|$)/.exec(text)
  if (number) return { kind: 'value', value: number[1] }
  const clock = /^(?:CURRENT_TIMESTAMP|NOW)(?:\((\d*)\))?(?=\s|,|$)/i.exec(text)
  if (clock) return { kind: 'clock', precision: Number(clock[1] || 0) }
  return { kind: 'unreviewed_expression', expression: text }
}

export function defaultDifference(actual, declaration) {
  const expected = plannedDefault(declaration)
  if (expected.kind === 'unreviewed_expression') return { status: 'requires_review', expected }
  const clock = /^(?:current_timestamp|now)\((\d*)\)$/i.exec(actual.column_default ?? '')
  if (expected.kind === 'clock') return { status: clock && Number(clock[1] || 0) === expected.precision ? 'matches' : 'different', expected }
  return { status: actual.column_default === expected.value ? 'matches' : 'different', expected }
}
