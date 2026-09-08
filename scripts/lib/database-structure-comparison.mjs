// Compare only type declarations. Nullability/defaults/collations/constraints and
// business meaning remain separate review obligations, even when tokens match.
export function databaseTypeToken(declaration) {
  const token = /^[a-z]+(?:\([^)]*\))?(?:\s+unsigned)?/i.exec(declaration)?.[0]
  if (!token) return null
  if (/^enum\(/i.test(token)) return 'enum' + token.slice(4).replace(/,\s*(?=')/g, ',')
  return token.toLowerCase().replace(/^(tinyint|smallint|mediumint|int|bigint)\(\d+\)/, '$1')
}
